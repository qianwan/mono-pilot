import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "../memory/embeddings/types.js";
import { tryListen, type LeaderConnectionHandle } from "./connection.js";
import {
	bindRpcConnection,
	type ClusterRequest,
	type RpcConnection,
	type ServiceDescriptor,
} from "./rpc.js";
import { createEmbeddingHandlers } from "./services/embedding.js";
import { createBusService, type BusHandle } from "./services/bus.js";
import { ServiceRegistry } from "./services/registry.js";
import { closeClusterV2, initClusterV2, type ClusterV2Service } from "./runtime.js";

function createMockEmbeddingProvider(model: string): EmbeddingProvider {
	return {
		id: "local",
		model,
		embedQuery: async (text) => [text.length],
		embedBatch: async (texts) => texts.map((text) => [text.length]),
		dispose: async () => {
			// no-op in tests
		},
	};
}

vi.mock("../memory/embeddings/local.js", () => ({
	createLocalEmbeddingProvider: async (params: { modelPath?: string }) =>
		createMockEmbeddingProvider(params.modelPath ?? "mock-local"),
}));

interface ExternalLeaderHandle {
	connection: LeaderConnectionHandle;
	bus: BusHandle;
	close: () => Promise<void>;
}

let externalLeader: ExternalLeaderHandle | null = null;

afterEach(async () => {
	if (externalLeader) {
		await externalLeader.close();
		externalLeader = null;
	}
	await closeClusterV2();
});

function uniqueScope(prefix: string): string {
	return `${prefix}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRole(
	params: {
		agentId: string;
		displayName: string;
		scope: string;
		modelPath: string;
		rpcTimeoutMs: number;
		getSessionId: () => string;
	},
	role: ClusterV2Service["role"],
	timeoutMs: number,
): Promise<ClusterV2Service> {
	const deadline = Date.now() + timeoutMs;
	let last: ClusterV2Service | null = null;
	while (Date.now() < deadline) {
		last = await initClusterV2(params);
		if (last.role === role) {
			return last;
		}
		await sleep(25);
	}
	throw new Error(`timed out waiting for role=${role}, last=${last?.role ?? "none"}`);
}

function registerDefaultServices(registry: ServiceRegistry): void {
	const services: ServiceDescriptor[] = [
		{ name: "embedding", version: "v2", capabilities: { methods: ["embedding.embedBatch"] } },
		{
			name: "bus",
			version: "v2",
			capabilities: {
				methods: ["bus.register", "bus.subscribe", "bus.send", "bus.broadcast", "bus.roster"],
			},
		},
	];
	for (const service of services) {
		registry.register(service);
	}
}

async function startExternalLeader(scope: string): Promise<ExternalLeaderHandle> {
	const connection = await tryListen({ scope });
	if (!connection) {
		throw new Error("failed to start external leader for test");
	}

	const registry = new ServiceRegistry();
	registerDefaultServices(registry);
	const busService = createBusService();
	const provider = createMockEmbeddingProvider("external-leader");
	const embeddingHandlers = createEmbeddingHandlers(provider);

	const handlers: Record<string, (request: ClusterRequest, connection: RpcConnection) => Promise<unknown>> = {
		"cluster.ping": async () => "pong",
		"registry.list": async () => registry.snapshot(),
		"registry.resolve": async (request) => {
			const name = (request.params as { name?: unknown } | null)?.name;
			if (!name || typeof name !== "string") {
				throw new Error("registry.resolve requires string name");
			}
			return {
				revision: registry.getRevision(),
				service: registry.resolve(name),
			};
		},
		...embeddingHandlers,
		...busService.handlers,
	};

	const sockets = new Set<net.Socket>();
	connection.server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => {
			sockets.delete(socket);
		});

		bindRpcConnection(
			socket,
			async (request, rpcConnection) => {
				const handler = handlers[request.method];
				if (!handler) {
					throw new Error(`unknown method: ${request.method}`);
				}
				return handler(request, rpcConnection);
			},
			{
				onClose: (rpcConnection) => {
					busService.onConnectionClosed(rpcConnection);
				},
			},
		);
	});

	const bus = busService.createLeaderHandle("leader-harness", "Leader Harness");

	return {
		connection,
		bus,
		close: async () => {
			for (const socket of sockets) {
				socket.destroy();
			}
			await connection.close();
			bus.close();
		},
	};
}

describe("cluster_v2 runtime failover integration", () => {
	it("re-elects after leader crash and keeps embedding/bus usable", async () => {
		const scope = uniqueScope("runtime-failover");
		externalLeader = await startExternalLeader(scope);

		const params = {
			agentId: "follower-a",
			displayName: "Follower A",
			scope,
			modelPath: "mock-local",
			rpcTimeoutMs: 500,
			getSessionId: () => "session-a",
		};

		const follower = await initClusterV2(params);
		expect(follower.role).toBe("follower");
		expect(follower.bus).not.toBeNull();

		const beforeFailoverEmbedding = await follower.embedding.embedBatch(["x", "hello"]);
		expect(beforeFailoverEmbedding).toEqual([[1], [5]]);

		const followerMessages: Array<{ text?: string }> = [];
		follower.bus?.onMessage((msg) => {
			if (typeof msg.payload === "object" && msg.payload !== null && "text" in msg.payload) {
				followerMessages.push(msg.payload as { text?: string });
			}
		});

		await externalLeader.bus.send("follower-a", { text: "before-failover" });
		await sleep(30);
		expect(followerMessages.some((m) => m.text === "before-failover")).toBe(true);

		await externalLeader.close();
		externalLeader = null;

		const reElected = await waitForRole(params, "leader", 4000);
		expect(reElected.role).toBe("leader");
		expect(reElected.bus).not.toBeNull();

		const afterFailoverEmbedding = await reElected.embedding.embedQuery("world");
		expect(afterFailoverEmbedding).toEqual([5]);

		const broadcastResult = await reElected.bus?.broadcast({ text: "after-failover" }, "public");
		expect(typeof broadcastResult?.seq).toBe("number");
	});
});
