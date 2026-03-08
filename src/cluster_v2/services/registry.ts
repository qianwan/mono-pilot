import type { ServiceDescriptor } from "../rpc.js";

/**
 * Leader-local service registry with monotonic revision.
 * Followers can use revision to invalidate stale snapshots after failover.
 */
export class ServiceRegistry {
	private readonly services = new Map<string, ServiceDescriptor>();
	private revision = 0;

	register(service: ServiceDescriptor): ServiceDescriptor {
		this.services.set(service.name, { ...service });
		this.revision++;
		return service;
	}

	unregister(name: string): boolean {
		const deleted = this.services.delete(name);
		if (deleted) {
			this.revision++;
		}
		return deleted;
	}

	resolve(name: string): ServiceDescriptor | undefined {
		const svc = this.services.get(name);
		return svc ? { ...svc } : undefined;
	}

	list(): ServiceDescriptor[] {
		return [...this.services.values()].map((service) => ({ ...service }));
	}

	getRevision(): number {
		return this.revision;
	}

	snapshot(): { revision: number; services: ServiceDescriptor[] } {
		return {
			revision: this.revision,
			services: this.list(),
		};
	}
}
