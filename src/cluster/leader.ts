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
} from "./protocol.js";
import { createLocalEmbeddingProvider } from "../memory/embeddings/local.js";
import type { EmbeddingProvider } from "../memory/embeddings/types.js";
import { clusterLog } from "./log.js";

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
}): Promise<LeaderHandle | null> {
	const server = await tryListen();
	if (!server) {
		clusterLog.debug("leader election lost (socket in use)");
		return null;
	}

	clusterLog.info("became leader, loading embedding model");
	const provider = await createLocalEmbeddingProvider(params);
	clusterLog.info("leader ready, serving embedding requests");

	server.on("connection", (socket) => {
		const remote = socket.remoteAddress ?? "unknown";
		clusterLog.info("follower connected", { remote });
		handleConnection(socket, provider);
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

function handleConnection(socket: net.Socket, provider: EmbeddingProvider): void {
	const decoder = new MessageDecoder();

	socket.on("data", (chunk) => {
		const messages = decoder.feed(chunk);
		for (const msg of messages) {
			void handleRequest(socket, msg as ClusterRequest, provider);
		}
	});

	socket.on("error", () => {
		clusterLog.debug("follower disconnected");
	});
}

async function handleRequest(
	socket: net.Socket,
	req: ClusterRequest,
	provider: EmbeddingProvider,
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
		default:
			clusterLog.warn("unknown method", { method: req.method, reqId: req.id });
			respond({ error: `unknown method: ${req.method}` });
	}
}