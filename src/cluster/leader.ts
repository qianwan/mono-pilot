import type net from "node:net";
import { tryListen, cleanupSocket } from "./socket.js";
import {
	CLUSTER_PROTOCOL_VERSION,
	encodeMessage,
	MessageDecoder,
	type ClusterRequest,
	type ClusterResponse,
	type EmbedBatchParams,
	type EmbedBatchResult,
	type ClusterPush,
	type RegisterParams,
	type SendParams,
	type BroadcastParams,
	type SubscribeParams,
	type MessagePushPayload,
	type PresencePushPayload,
} from "./protocol.js";
import { createLocalEmbeddingProvider } from "../memory/embeddings/local.js";
import type { EmbeddingProvider } from "../memory/embeddings/types.js";
import { clusterLog } from "./log.js";

// --- Route table ---

interface ConnectedAgent {
	agentId: string;
	socket: net.Socket;
	channels: Set<string>;
}

const agents = new Map<string, ConnectedAgent>();
let messageSeq = 0;

function pushTo(socket: net.Socket, method: string, payload: unknown): void {
	if (!socket.destroyed) {
		socket.write(encodeMessage({ type: "push", method, payload } satisfies ClusterPush));
	}
}

function broadcastPresence(agentId: string, status: "joined" | "left", exclude?: string): void {
	const payload: PresencePushPayload = { agentId, status };
	for (const [id, agent] of agents) {
		if (id !== exclude) pushTo(agent.socket, "presence", payload);
	}
}

export interface LeaderHandle {
	/** The embedding provider owned by this leader. */
	provider: EmbeddingProvider;
	/** Shut down the leader server and release resources. */
	close: () => Promise<void>;
}

/**
 * Try to become the cluster leader.
 * Returns a LeaderHandle on success, or null if another leader is already running.
 */
export async function tryBecomeLeader(params: {
	modelPath?: string;
	modelCacheDir?: string;
	/** Pre-built provider (skips model loading — useful for testing). */
	provider?: EmbeddingProvider;
}): Promise<LeaderHandle | null> {
	const server = await tryListen();
	if (!server) {
		clusterLog.debug("leader election lost (socket in use)");
		return null;
	}

	let provider: EmbeddingProvider;
	if (params.provider) {
		provider = params.provider;
		clusterLog.info("became leader, using provided embedding provider");
	} else {
		clusterLog.info("became leader, loading embedding model");
		provider = await createLocalEmbeddingProvider(params);
	}
	clusterLog.info("leader ready, serving embedding requests");

	server.on("connection", (socket) => {
		const remote = socket.remoteAddress ?? "unknown";
		clusterLog.info("follower connected", { remote });
		handleConnection(socket, provider, server);
	});

	const close = async () => {
		clusterLog.info("leader shutting down");
		server.close();
		cleanupSocket();
		if (provider.dispose) await provider.dispose();
	};

	// Clean up on process exit
	const onExit = () => {
		server.close();
		cleanupSocket();
	};
	process.on("exit", onExit);
	process.on("SIGINT", onExit);
	process.on("SIGTERM", onExit);

	return { provider, close };
}

function handleConnection(socket: net.Socket, provider: EmbeddingProvider, _server: net.Server): void {
	const decoder = new MessageDecoder();
	let registeredId: string | undefined;

	socket.on("data", (chunk) => {
		const messages = decoder.feed(chunk);
		for (const msg of messages) {
			void handleRequest(socket, msg as ClusterRequest, provider, () => registeredId, (id) => { registeredId = id; });
		}
	});

	const cleanup = () => {
		if (registeredId) {
			clusterLog.info("follower left", { agentId: registeredId });
			agents.delete(registeredId);
			broadcastPresence(registeredId, "left");
			registeredId = undefined;
		}
	};

	socket.on("error", (err) => {
		clusterLog.debug("follower socket error", { error: String(err) });
		cleanup();
	});

	socket.on("close", () => {
		cleanup();
	});
}

async function handleRequest(
	socket: net.Socket,
	req: ClusterRequest,
	provider: EmbeddingProvider,
	getRegisteredId: () => string | undefined,
	setRegisteredId: (id: string) => void,
): Promise<void> {
	const respond = (res: Omit<ClusterResponse, "id">) => {
		if (!socket.destroyed) {
			socket.write(encodeMessage({ id: req.id, ...res }));
		}
	};

	if (req.version !== CLUSTER_PROTOCOL_VERSION) {
		clusterLog.warn("protocol version mismatch", { expected: CLUSTER_PROTOCOL_VERSION, got: req.version });
		respond({ error: `unsupported protocol version: ${req.version}` });
		return;
	}

	switch (req.method) {
		case "ping": {
			respond({ result: "pong" });
			break;
		}
		case "embed": {
			try {
				const { texts } = req.params as EmbedBatchParams;
				clusterLog.debug("embed request", { count: texts.length, reqId: req.id, ...req.from });
				const vectors = await provider.embedBatch(texts);
				respond({ result: { vectors } satisfies EmbedBatchResult });
			} catch (err) {
				clusterLog.error("embed failed", { reqId: req.id, error: err instanceof Error ? err.message : String(err) });
				respond({ error: err instanceof Error ? err.message : String(err) });
			}
			break;
		}
		case "register": {
			const { agentId, channels } = req.params as RegisterParams;
			if (!agentId) {
				respond({ error: "register requires agentId" });
				break;
			}
			// Evict previous registration with same agentId (reconnect scenario)
			const existing = agents.get(agentId);
			if (existing && existing.socket !== socket) {
				existing.socket.destroy();
			}
			const defaultChannels = ["public", `private:${agentId}`];
			const entry: ConnectedAgent = {
				agentId,
				socket,
				channels: new Set([...defaultChannels, ...(channels ?? [])]),
			};
			agents.set(agentId, entry);
			setRegisteredId(agentId);
			clusterLog.info("agent registered", { agentId, channels: [...entry.channels] });
			// Notify existing agents about the newcomer
			broadcastPresence(agentId, "joined", agentId);
			// Notify the newcomer about all existing agents
			for (const [id] of agents) {
				if (id !== agentId) pushTo(socket, "presence", { agentId: id, status: "joined" } satisfies PresencePushPayload);
			}
			respond({ result: { agentId, channels: [...entry.channels] } });
			break;
		}
		case "subscribe": {
			const registeredId = getRegisteredId();
			if (!registeredId) {
				respond({ error: "must register before subscribe" });
				break;
			}
			const agent = agents.get(registeredId);
			if (!agent) {
				respond({ error: "agent not found in route table" });
				break;
			}
			const { channels } = req.params as SubscribeParams;
			for (const ch of channels) agent.channels.add(ch);
			clusterLog.debug("subscribe", { agentId: registeredId, channels });
			respond({ result: { channels: [...agent.channels] } });
			break;
		}
		case "send": {
			const registeredId = getRegisteredId();
			if (!registeredId) {
				respond({ error: "must register before send" });
				break;
			}
			const { to, channel, payload } = req.params as SendParams;
			const target = agents.get(to);
			if (!target) {
				respond({ error: `agent not found: ${to}` });
				break;
			}
			const seq = ++messageSeq;
			const pushPayload: MessagePushPayload = { from: registeredId, channel, payload, seq };
			pushTo(target.socket, "message", pushPayload);
			clusterLog.debug("send", { from: registeredId, to, seq });
			respond({ result: { seq } });
			break;
		}
		case "broadcast": {
			const registeredId = getRegisteredId();
			if (!registeredId) {
				respond({ error: "must register before broadcast" });
				break;
			}
			const { channel, payload } = req.params as BroadcastParams;
			const targetChannel = channel ?? "public";
			const seq = ++messageSeq;
			const pushPayload: MessagePushPayload = { from: registeredId, channel: targetChannel, payload, seq };
			let delivered = 0;
			for (const [id, agent] of agents) {
				if (id === registeredId) continue;
				if (agent.channels.has(targetChannel)) {
					pushTo(agent.socket, "message", pushPayload);
					delivered++;
				}
			}
			clusterLog.debug("broadcast", { from: registeredId, channel: targetChannel, seq, delivered });
			respond({ result: { seq, delivered } });
			break;
		}
		case "roster": {
			const roster = [...agents.entries()].map(([id, a]) => ({
				agentId: id,
				channels: [...a.channels],
			}));
			respond({ result: { agents: roster } });
			break;
		}
		default:
			clusterLog.warn("unknown method", { method: req.method, reqId: req.id });
			respond({ error: `unknown method: ${req.method}` });
	}
}