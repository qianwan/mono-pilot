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

interface LifecycleRecord {
	event: string;
	scope: string | null;
	role: string | null;
	fromState?: string;
	toState?: string;
	label?: string;
}

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

function parseLifecycleRecords(calls: Array<unknown[]>): LifecycleRecord[] {
	const records: LifecycleRecord[] = [];
	for (const call of calls) {
		const line = call[0];
		if (typeof line !== "string" || !line.startsWith("[cluster_v2] ")) {
			continue;
		}
		const payload = line.slice("[cluster_v2] ".length);
		try {
			const parsed = JSON.parse(payload) as LifecycleRecord;
			records.push(parsed);
		} catch {
			// ignore non-json log lines in tests
		}
	}
	return records;
}

const ALLOWED_TRANSITIONS = new Set([
	"disconnected->connecting",
	"disconnected->closed",
	"connecting->connected",
	"connecting->disconnected",
	"connecting->closed",
	"connected->reconnecting",
	"connected->disconnected",
	"connected->closed",
	"reconnecting->connecting",
	"reconnecting->disconnected",
	"reconnecting->closed",
	"closed->connecting",
]);

describe("cluster_v2 runtime lifecycle integration", () => {
	it("keeps leader lifecycle transitions within the state machine", async () => {
		const scope = uniqueScope("runtime-leader-lifecycle");
		const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {
			// mute test logs
		});

		try {
			const params = {
				agentId: "leader-a",
				displayName: "Leader A",
				scope,
				modelPath: "mock-local",
				rpcTimeoutMs: 500,
				getSessionId: () => "leader-session",
			};

			const service = await initClusterV2(params);
			expect(service.role).toBe("leader");

			await closeClusterV2();

			const records = parseLifecycleRecords(infoSpy.mock.calls)
				.filter((record) => record.event === "connection_lifecycle_transition" && record.scope === scope);

			const leaderTransitions = records.filter((record) => record.role === "leader");
			expect(leaderTransitions.length).toBeGreaterThanOrEqual(3);

			for (const transition of leaderTransitions) {
				const edge = `${transition.fromState ?? ""}->${transition.toState ?? ""}`;
				expect(ALLOWED_TRANSITIONS.has(edge)).toBe(true);
			}

			expect(
				leaderTransitions.some(
					(transition) => transition.fromState === "disconnected" && transition.toState === "connecting",
				),
			).toBe(true);
			expect(
				leaderTransitions.some(
					(transition) => transition.fromState === "connecting" && transition.toState === "connected",
				),
			).toBe(true);
			expect(
				leaderTransitions.some(
					(transition) =>
						transition.fromState === "connected" &&
						transition.toState === "closed" &&
						transition.label?.startsWith("leader_close:"),
				),
			).toBe(true);
		} finally {
			infoSpy.mockRestore();
		}
	});

	it("drives follower through reconnect lifecycle after leader loss", async () => {
		const scope = uniqueScope("runtime-follower-lifecycle");
		externalLeader = await startExternalLeader(scope);

		const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {
			// mute test logs
		});

		try {
			const params = {
				agentId: "follower-a",
				displayName: "Follower A",
				scope,
				modelPath: "mock-local",
				rpcTimeoutMs: 500,
				getSessionId: () => "follower-session",
			};

			const follower = await initClusterV2(params);
			expect(follower.role).toBe("follower");

			await externalLeader.close();
			externalLeader = null;

			await waitForRole(params, "leader", 4000);

			const records = parseLifecycleRecords(infoSpy.mock.calls)
				.filter((record) => record.event === "connection_lifecycle_transition" && record.scope === scope);

			for (const transition of records) {
				const edge = `${transition.fromState ?? ""}->${transition.toState ?? ""}`;
				expect(ALLOWED_TRANSITIONS.has(edge)).toBe(true);
			}

			const followerTransitions = records.filter((record) => record.role === "follower");
			expect(
				followerTransitions.some(
					(transition) => transition.fromState === "connecting" && transition.toState === "connected",
				),
			).toBe(true);
			expect(
				followerTransitions.some(
					(transition) =>
						transition.fromState === "connected" &&
						transition.toState === "reconnecting" &&
						transition.label === "follower_disconnect",
				),
			).toBe(true);
			expect(
				followerTransitions.some(
					(transition) =>
						transition.fromState === "reconnecting" && transition.toState === "disconnected",
				),
			).toBe(true);
		} finally {
			infoSpy.mockRestore();
		}
	});
});
