import type net from "node:net";
import { tryConnect } from "./socket.js";
import {
	CLUSTER_PROTOCOL_VERSION,
	encodeMessage,
	MessageDecoder,
	type ClusterResponse,
	type ClusterRequest,
	type EmbedBatchParams,
	type EmbedBatchResult,
} from "./protocol.js";
import type { EmbeddingProvider } from "../memory/embeddings/types.js";
import { clusterLog } from "./log.js";

export interface FollowerIdentity {
	agentId?: string;
	sessionId?: string;
}

export interface FollowerHandle {
	/** Embedding provider that delegates to the leader over IPC. */
	provider: EmbeddingProvider;
	/** Disconnect from the leader. */
	close: () => void;
	/** Called when the connection to the leader drops unexpectedly. */
	onDisconnect?: () => void;
}

/**
 * Try to connect to an existing cluster leader.
 * Returns a FollowerHandle on success, or null if no leader is running.
 */
export async function tryFollowLeader(modelId: string, identity?: FollowerIdentity): Promise<FollowerHandle | null> {
	const socket = await tryConnect();
	if (!socket) {
		clusterLog.debug("no leader found, cannot follow");
		return null;
	}

	// Verify the leader is alive with a ping
	const client = new ClusterClient(socket, identity);
	try {
		const pong = await client.call("ping", null, 3000);
		if (pong !== "pong") {
			clusterLog.warn("leader ping returned unexpected response", { pong });
			client.close();
			return null;
		}
	} catch {
		clusterLog.warn("leader ping failed, disconnecting");
		client.close();
		return null;
	}

	clusterLog.info("connected as follower");

	const provider: EmbeddingProvider = {
		id: "local",
		model: modelId,
		embedQuery: async (text) => {
			const result = await client.call<EmbedBatchResult>("embed", { texts: [text] } satisfies EmbedBatchParams);
			return result.vectors[0]!;
		},
		embedBatch: async (texts) => {
			const result = await client.call<EmbedBatchResult>("embed", { texts } satisfies EmbedBatchParams);
			return result.vectors;
		},
		dispose: async () => {
			client.close();
		},
	};

	const handle: FollowerHandle = { provider, close: () => client.close() };

	client.onDisconnect(() => {
		if (handle.onDisconnect) handle.onDisconnect();
	});

	return handle;
}

/**
 * Low-level RPC client over a connected Unix socket.
 */
class ClusterClient {
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	private decoder = new MessageDecoder();
	private closed = false;
	private from: ClusterRequest["from"];

	constructor(private socket: net.Socket, identity?: FollowerIdentity) {
		this.from = { pid: process.pid, ...identity };
		socket.on("data", (chunk) => {
			const messages = this.decoder.feed(chunk);
			for (const msg of messages) {
				const res = msg as ClusterResponse;
				const handler = this.pending.get(res.id);
				if (handler) {
					this.pending.delete(res.id);
					if (res.error) {
						handler.reject(new Error(res.error));
					} else {
						handler.resolve(res.result);
					}
				}
			}
		});

		socket.on("error", () => this.abortAll("socket error"));
		socket.on("close", () => {
			clusterLog.info("connection to leader closed", { pending: this.pending.size });
			this.abortAll("socket closed");
			this.disconnectCallback?.();
		});
	}

	private disconnectCallback?: () => void;

	onDisconnect(cb: () => void): void {
		this.disconnectCallback = cb;
	}

	call<T = unknown>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
		if (this.closed) return Promise.reject(new Error("client closed"));

		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`cluster RPC timeout: ${method}`));
			}, timeoutMs);

			this.pending.set(id, {
				resolve: (v) => {
					clearTimeout(timer);
					resolve(v);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});

			this.socket.write(
				encodeMessage({ id, version: CLUSTER_PROTOCOL_VERSION, method, params, from: this.from }),
			);
		});
	}

	close(): void {
		clusterLog.debug("follower client closing");
		this.closed = true;
		this.socket.destroy();
		this.abortAll("client closed");
	}

	private abortAll(reason: string): void {
		for (const [, handler] of this.pending) {
			handler.reject(new Error(reason));
		}
		this.pending.clear();
	}
}