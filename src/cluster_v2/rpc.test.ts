import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	bindRpcConnection,
	ClusterRpcClient,
	encodeMessage,
	MessageDecoder,
	type ClusterRequest,
	type ClusterResponse,
	type RpcRequestHandler,
} from "./rpc.js";

interface ServerHandle {
	dir: string;
	socketPath: string;
	server: net.Server;
}

const activeServers: ServerHandle[] = [];
const activeClients: ClusterRpcClient[] = [];

afterEach(async () => {
	for (const client of activeClients.splice(0)) {
		client.close();
	}

	for (const handle of activeServers.splice(0)) {
		await new Promise<void>((resolve) => handle.server.close(() => resolve()));
		await rm(handle.dir, { recursive: true, force: true });
	}
});

async function startRpcServer(
	handler: RpcRequestHandler,
	options?: { maxInFlight?: number; maxQueue?: number },
): Promise<ServerHandle> {
	const dir = await mkdtemp(join(tmpdir(), "cluster-v2-rpc-test-"));
	const socketPath = join(dir, "rpc.sock");
	const server = net.createServer((socket) => {
		bindRpcConnection(socket, handler, {
			backpressure: {
				maxInFlight: options?.maxInFlight,
				maxQueue: options?.maxQueue,
			},
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => resolve());
	});

	const handle = { dir, socketPath, server };
	activeServers.push(handle);
	return handle;
}

async function connectClient(socketPath: string): Promise<ClusterRpcClient> {
	const socket = await new Promise<net.Socket>((resolve, reject) => {
		const s = net.createConnection(socketPath);
		s.once("connect", () => resolve(s));
		s.once("error", reject);
	});
	const client = new ClusterRpcClient(socket, {
		agentId: "rpc-test",
		sessionId: "session-test",
		scope: "rpc-test",
		role: "rpc-test-client",
	});
	activeClients.push(client);
	return client;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("cluster_v2 rpc", () => {
	it("rejects timeout path deterministically", async () => {
		const server = await startRpcServer(async () => {
			await new Promise(() => {
				// never resolves
			});
			return null;
		});

		const client = await connectClient(server.socketPath);
		await expect(client.call("hang", {}, { timeoutMs: 40 })).rejects.toThrow("timeout");
	});

	it("ignores late duplicate response for same request id", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cluster-v2-rpc-dup-"));
		const socketPath = join(dir, "rpc.sock");
		const server = net.createServer((socket) => {
			const decoder = new MessageDecoder();
			socket.on("data", (chunk) => {
				const messages = decoder.feed(chunk);
				for (const msg of messages) {
					if (!("method" in msg)) continue;
					const req = msg as ClusterRequest;
					const first: ClusterResponse = { id: req.id, result: { value: 1 } };
					const duplicate: ClusterResponse = { id: req.id, result: { value: 2 } };
					socket.write(encodeMessage(first));
					socket.write(encodeMessage(duplicate));
				}
			});
		});

		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, () => resolve());
		});
		activeServers.push({ dir, socketPath, server });

		const client = await connectClient(socketPath);
		const result = await client.call<{ value: number }>("dup", {}, { timeoutMs: 200 });
		expect(result.value).toBe(1);
	});

	it("enforces backpressure bounds and returns overload error", async () => {
		const server = await startRpcServer(
			async () => {
				await sleep(80);
				return { ok: true };
			},
			{ maxInFlight: 1, maxQueue: 1 },
		);

		const client = await connectClient(server.socketPath);

		const p1 = client.call("slow", { n: 1 }, { timeoutMs: 500 });
		const p2 = client.call("slow", { n: 2 }, { timeoutMs: 500 });
		const p3 = client.call("slow", { n: 3 }, { timeoutMs: 500 });

		const [r1, r2, r3] = await Promise.allSettled([p1, p2, p3]);

		expect(r1.status).toBe("fulfilled");
		expect(r2.status).toBe("fulfilled");
		expect(r3.status).toBe("rejected");
		if (r3.status === "rejected") {
			expect(String(r3.reason?.message ?? r3.reason)).toContain("queue limit 1 reached");
		}
	});
});
