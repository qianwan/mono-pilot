import { describe, it, expect, vi } from "vitest";
import { FollowerRegistryCache } from "./registry-cache.js";
import { createClusterLogContext } from "../observability.js";
import type { ClusterRpcClient, ServiceDescriptor } from "../rpc.js";

function createClientStub(
	resolver: (method: string, params: unknown) => Promise<unknown>,
): ClusterRpcClient {
	return {
		call: vi.fn((method: string, params: unknown) => resolver(method, params)),
	} as unknown as ClusterRpcClient;
}

function service(name: string): ServiceDescriptor {
	return { name, version: "v2" };
}

describe("cluster_v2 follower registry cache", () => {
	it("refreshes cache and resolves required services", async () => {
		const client = createClientStub(async (method, params) => {
			if (method === "registry.list") {
				return { revision: 3, services: [service("embedding"), service("bus")] };
			}
			if (method === "registry.resolve") {
				const name = (params as { name: string }).name;
				return { revision: 3, service: service(name) };
			}
			throw new Error(`unexpected method: ${method}`);
		});

		const cache = new FollowerRegistryCache(client, createClusterLogContext({ role: "test" }));
		await cache.refresh();

		expect(cache.currentRevision()).toBe(3);
		await expect(cache.requireService("embedding")).resolves.toEqual(service("embedding"));
		await expect(cache.requireService("bus")).resolves.toEqual(service("bus"));
	});

	it("invalidates and rejects stale resolve when revision regresses", async () => {
		let phase: "list" | "resolve" = "list";
		const client = createClientStub(async (method) => {
			if (method === "registry.list" && phase === "list") {
				phase = "resolve";
				return { revision: 5, services: [service("embedding")] };
			}
			if (method === "registry.resolve" && phase === "resolve") {
				return { revision: 4, service: service("bus") };
			}
			throw new Error(`unexpected call for phase ${phase}: ${method}`);
		});

		const cache = new FollowerRegistryCache(client, createClusterLogContext({ role: "test" }));
		await cache.refresh();
		expect(cache.currentRevision()).toBe(5);

		await expect(cache.resolve("bus")).rejects.toThrow("stale");
		expect(cache.currentRevision()).toBe(0);
	});

	it("drops cache contents on explicit invalidation", async () => {
		const client = createClientStub(async (method, params) => {
			if (method === "registry.list") {
				return { revision: 2, services: [service("embedding")] };
			}
			if (method === "registry.resolve") {
				const name = (params as { name: string }).name;
				return { revision: 2, service: name === "embedding" ? undefined : service(name) };
			}
			throw new Error(`unexpected method: ${method}`);
		});

		const cache = new FollowerRegistryCache(client, createClusterLogContext({ role: "test" }));
		await cache.refresh();
		expect(cache.currentRevision()).toBe(2);

		cache.invalidate("leader_disconnect");
		expect(cache.currentRevision()).toBe(0);
		await expect(cache.requireService("embedding")).rejects.toThrow("required service unavailable");
	});
});
