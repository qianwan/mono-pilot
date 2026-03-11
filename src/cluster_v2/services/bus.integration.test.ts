import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	bindRpcConnection,
	ClusterRpcClient,
	type ClusterRequest,
	type RpcConnection,
} from "../rpc.js";
import { connectBusClient, createBusService, type BusHandle, type BusService } from "./bus.js";
import type { MessagePushPayload, PresencePushPayload } from "../rpc.js";

interface RpcServerHandle {
	dir: string;
	socketPath: string;
	server: net.Server;
	busService: BusService;
}

const activeServers: RpcServerHandle[] = [];
const activeClients: ClusterRpcClient[] = [];
const activeBuses: BusHandle[] = [];

afterEach(async () => {
	for (const bus of activeBuses.splice(0)) {
		bus.close();
	}

	for (const client of activeClients.splice(0)) {
		client.close();
	}

	for (const server of activeServers.splice(0)) {
		await new Promise<void>((resolve) => server.server.close(() => resolve()));
		await rm(server.dir, { recursive: true, force: true });
	}
});

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function startBusServer(): Promise<RpcServerHandle> {
	const busService = createBusService();
	const handlers: Record<string, (request: ClusterRequest, connection: RpcConnection) => Promise<unknown>> = {
		...busService.handlers,
	};

	const dir = await mkdtemp(join(tmpdir(), "cluster-v2-bus-test-"));
	const socketPath = join(dir, "bus.sock");
	const server = net.createServer((socket) => {
		bindRpcConnection(
			socket,
			async (request, connection) => {
				const handler = handlers[request.method];
				if (!handler) {
					throw new Error(`unknown method: ${request.method}`);
				}
				return handler(request, connection);
			},
			{
				onClose: (connection) => {
					busService.onConnectionClosed(connection);
				},
			},
		);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => resolve());
	});

	const handle = { dir, socketPath, server, busService };
	activeServers.push(handle);
	return handle;
}

async function connectClient(socketPath: string, agentId: string): Promise<ClusterRpcClient> {
	const socket = await new Promise<net.Socket>((resolve, reject) => {
		const s = net.createConnection(socketPath);
		s.once("connect", () => resolve(s));
		s.once("error", reject);
	});

	const client = new ClusterRpcClient(socket, {
		agentId,
		sessionId: `${agentId}-session`,
		scope: "bus-test",
		role: "bus-test-client",
	});
	activeClients.push(client);
	return client;
}

describe("cluster_v2 bus integration", () => {
	it("keeps roster/presence consistent across join and leave", async () => {
		const server = await startBusServer();

		const aliceClient = await connectClient(server.socketPath, "alice");
		const aliceBus = await connectBusClient(aliceClient, "alice", "Alice", ["public"]);
		activeBuses.push(aliceBus);

		const alicePresence: PresencePushPayload[] = [];
		aliceBus.onPresence((evt) => {
			alicePresence.push(evt);
		});

		const bobClient = await connectClient(server.socketPath, "bob");
		const bobBus = await connectBusClient(bobClient, "bob", "Bob", ["public"]);
		activeBuses.push(bobBus);

		const bobPresence: PresencePushPayload[] = [];
		bobBus.onPresence((evt) => {
			bobPresence.push(evt);
		});

		await sleep(30);

		expect(alicePresence.some((evt) => evt.agentId === "bob" && evt.status === "joined")).toBe(true);
		expect(bobPresence.some((evt) => evt.agentId === "alice" && evt.status === "joined")).toBe(true);

		const { agents } = await aliceBus.roster();
		expect(agents.map((agent) => agent.agentId).sort()).toEqual(["alice", "bob"]);
		expect(agents.map((agent) => agent.role).sort()).toEqual(["follower", "follower"]);

		bobClient.close();
		await sleep(30);

		expect(alicePresence.some((evt) => evt.agentId === "bob" && evt.status === "left")).toBe(true);
	});

	it("enforces channel isolation and no self-broadcast delivery", async () => {
		const server = await startBusServer();

		const aliceClient = await connectClient(server.socketPath, "alice");
		const bobClient = await connectClient(server.socketPath, "bob");

		const aliceBus = await connectBusClient(aliceClient, "alice", "Alice", ["public"]);
		const bobBus = await connectBusClient(bobClient, "bob", "Bob", ["public"]);
		activeBuses.push(aliceBus, bobBus);

		const aliceMessages: MessagePushPayload[] = [];
		const bobMessages: MessagePushPayload[] = [];
		aliceBus.onMessage((msg) => {
			aliceMessages.push(msg);
		});
		bobBus.onMessage((msg) => {
			bobMessages.push(msg);
		});

		await bobBus.subscribe(["secret"]);
		await aliceBus.broadcast({ text: "private payload" }, "secret");
		await sleep(30);

		expect(bobMessages.some((msg) => msg.channel === "secret")).toBe(true);
		expect(aliceMessages.length).toBe(0);

		await aliceBus.broadcast({ text: "public payload" }, "public");
		await sleep(30);

		expect(bobMessages.some((msg) => msg.channel === "public")).toBe(true);
		expect(aliceMessages.length).toBe(0);
	});

	it("keeps leader role when same agent re-registers as follower", async () => {
		const server = await startBusServer();

		const leaderBus = server.busService.createLeaderHandle("same-agent", "Leader");
		activeBuses.push(leaderBus);

		const duplicateClient = await connectClient(server.socketPath, "same-agent");
		const duplicateBus = await connectBusClient(duplicateClient, "same-agent", "Follower", ["secret"]);
		activeBuses.push(duplicateBus);

		await sleep(30);

		const firstRoster = await leaderBus.roster();
		expect(firstRoster.agents).toHaveLength(1);
		expect(firstRoster.agents[0].agentId).toBe("same-agent");
		expect(firstRoster.agents[0].role).toBe("leader");
		expect(firstRoster.agents[0].channels).toEqual(
			expect.arrayContaining(["public", "private:same-agent", "secret"]),
		);

		duplicateClient.close();
		await sleep(30);

		const secondRoster = await leaderBus.roster();
		expect(secondRoster.agents).toHaveLength(1);
		expect(secondRoster.agents[0].role).toBe("leader");
	});
});
