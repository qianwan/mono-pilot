import type { ClusterRpcClient, ServiceDescriptor } from "../rpc.js";
import { logClusterEvent, type ClusterLogContext } from "../observability.js";

interface RegistryListResponse {
	revision: number;
	services: ServiceDescriptor[];
}

interface RegistryResolveResponse {
	revision: number;
	service?: ServiceDescriptor;
}

/**
 * Follower-side registry cache with revision-bound guards.
 *
 * Conformance invariant: cacheRevision <= registryRevision.
 */
export class FollowerRegistryCache {
	private revision = 0;
	private readonly services = new Map<string, ServiceDescriptor>();

	constructor(
		private readonly client: ClusterRpcClient,
		private readonly context: ClusterLogContext,
	) {}

	currentRevision(): number {
		return this.revision;
	}

	invalidate(reason: string): void {
		if (this.revision !== 0 || this.services.size > 0) {
			logClusterEvent("info", "registry_cache_invalidated", this.context, {
				reason,
				cacheRevision: this.revision,
				cachedServices: this.services.size,
			});
		}
		this.revision = 0;
		this.services.clear();
	}

	async refresh(): Promise<number> {
		const snapshot = await this.client.call<RegistryListResponse>("registry.list", {});
		this.applySnapshot(snapshot, "refresh");
		return this.revision;
	}

	async resolve(name: string): Promise<ServiceDescriptor | undefined> {
		const cached = this.services.get(name);
		if (cached) {
			return { ...cached };
		}

		const response = await this.client.call<RegistryResolveResponse>("registry.resolve", { name });
		this.applyResolve(name, response);
		const resolved = this.services.get(name);
		return resolved ? { ...resolved } : undefined;
	}

	async requireService(name: string): Promise<ServiceDescriptor> {
		const service = await this.resolve(name);
		if (!service) {
			throw new Error(`required service unavailable: ${name}`);
		}
		return service;
	}

	private applySnapshot(snapshot: RegistryListResponse, source: string): void {
		const registryRevision = this.normalizeRevision(snapshot.revision, source);
		if (registryRevision < this.revision) {
			logClusterEvent("warn", "registry_revision_regressed", this.context, {
				source,
				cacheRevision: this.revision,
				registryRevision,
			});
			this.invalidate("revision_regressed");
		}

		this.assertCacheBound(registryRevision, `${source}:pre_apply`);
		this.revision = registryRevision;
		this.services.clear();
		for (const service of snapshot.services) {
			this.services.set(service.name, { ...service });
		}
		this.assertCacheBound(registryRevision, `${source}:post_apply`);
	}

	private applyResolve(name: string, response: RegistryResolveResponse): void {
		const registryRevision = this.normalizeRevision(response.revision, "resolve");
		if (registryRevision < this.revision) {
			logClusterEvent("warn", "registry_resolve_revision_regressed", this.context, {
				cacheRevision: this.revision,
				registryRevision,
				serviceName: name,
			});
			this.invalidate("resolve_revision_regressed");
			throw new Error("registry cache stale after leader change; refresh required");
		}

		this.assertCacheBound(registryRevision, "resolve:pre_apply");
		this.revision = registryRevision;
		if (response.service) {
			this.services.set(name, { ...response.service });
		} else {
			this.services.delete(name);
		}
		this.assertCacheBound(registryRevision, "resolve:post_apply");
	}

	private assertCacheBound(registryRevision: number, source: string): void {
		if (this.revision > registryRevision) {
			logClusterEvent("warn", "registry_cache_bound_violation", this.context, {
				source,
				cacheRevision: this.revision,
				registryRevision,
			});
			throw new Error(
				`registry cache invariant violated: cacheVersion ${this.revision} > registryVersion ${registryRevision}`,
			);
		}
	}

	private normalizeRevision(revision: number, source: string): number {
		if (!Number.isInteger(revision) || revision < 0) {
			throw new Error(`invalid registry revision from ${source}: ${String(revision)}`);
		}
		return revision;
	}
}
