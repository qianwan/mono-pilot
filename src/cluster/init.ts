/**
 * Unified cluster entry point.
 *
 * Initializes the cluster (leader or follower), returning a single ClusterService
 * that provides both embedding and message bus capabilities.
 */
import { tryBecomeLeader } from "./leader.js";
import { tryFollowLeader, type FollowerHandle, type FollowerIdentity } from "./follower.js";
import { createEmbeddingHandler } from "./services/embedding.js";
import { createBusHandler } from "./services/bus.js";
import { createLeaderBus } from "./services/bus.js";
import { connectBus, type BusHandle } from "./bus.js";
import type { EmbeddingProvider } from "../memory/embeddings/types.js";
import { clusterLog, setLogContext } from "./log.js";

export interface ClusterService {
	role: "leader" | "follower";
	embedding: EmbeddingProvider;
	bus: BusHandle | null;
	close(): Promise<void>;
}

export interface ClusterInitParams {
	modelPath?: string;
	modelCacheDir?: string;
	agentId: string;
	displayName?: string;
	getSessionId?: () => string;
}

let activeService: ClusterService | null = null;
let cachedParams: ClusterInitParams | null = null;
let reElecting: Promise<void> | null = null;

/**
 * Initialize the cluster. Tries follower first, falls back to leader.
 * Returns a ClusterService with both embedding and bus.
 */
export async function initCluster(params: ClusterInitParams): Promise<ClusterService> {
	if (activeService) return activeService;

	cachedParams = params;
	const { agentId, getSessionId } = params;
	setLogContext(() => ({
		...(agentId ? { agentId } : {}),
		...(getSessionId ? { sessionId: getSessionId() } : {}),
	}));
	const modelId = params.modelPath ?? "local";
	const identity: FollowerIdentity = {
		...(agentId ? { agentId } : {}),
		...(getSessionId ? { sessionId: getSessionId() } : {}),
	};

	// Try follower first — avoids loading model if leader exists
	clusterLog.info("resolving cluster role");
	const follower = await tryFollowLeader(modelId, identity);
	if (follower) {
		clusterLog.info("resolved as follower");
		activeService = await makeFollowerService(follower, agentId, params);
		return activeService;
	}

	// No leader — become one
	activeService = await makeLeaderService(params);
	if (activeService) return activeService;

	// Race condition: another process just became leader between our two attempts
	const retryFollower = await tryFollowLeader(modelId, identity);
	if (retryFollower) {
		clusterLog.info("resolved as follower (retry)");
		activeService = await makeFollowerService(retryFollower, agentId, params);
		return activeService;
	}

	// Fallback: standalone (no cluster)
	clusterLog.warn("cluster unavailable, loading model directly (standalone)");
	const { createLocalEmbeddingProvider } = await import("../memory/embeddings/local.js");
	const provider = await createLocalEmbeddingProvider(params);
	activeService = {
		role: "leader",
		embedding: provider,
		bus: null,
		async close() {
			if (provider.dispose) await provider.dispose();
			activeService = null;
		},
	};
	return activeService;
}

export async function closeCluster(): Promise<void> {
	if (activeService) {
		clusterLog.info("closing cluster", { role: activeService.role });
		await activeService.close();
		activeService = null;
	}
}

// --- Leader setup ---

async function makeLeaderService(params: ClusterInitParams): Promise<ClusterService | null> {
	const { createLocalEmbeddingProvider } = await import("../memory/embeddings/local.js");

	clusterLog.info("trying to become leader, loading embedding model");
	const provider = await createLocalEmbeddingProvider(params);

	const embeddingHandler = createEmbeddingHandler(provider);
	const busHandler = createBusHandler();

	const leader = await tryBecomeLeader(
		[embeddingHandler, busHandler],
		async () => { if (provider.dispose) await provider.dispose(); },
	);

	if (!leader) {
		// Lost election — dispose the model we just loaded
		if (provider.dispose) await provider.dispose();
		return null;
	}

	clusterLog.info("resolved as leader");
	const bus = createLeaderBus(params.agentId, params.displayName);

	return {
		role: "leader",
		embedding: provider,
		bus,
		async close() {
			bus.close();
			await leader.close();
			activeService = null;
		},
	};
}

// --- Follower setup ---

async function makeFollowerService(handle: FollowerHandle, agentId: string, params: ClusterInitParams): Promise<ClusterService> {
	const inner = handle.provider;

	// Proactive re-election on leader disconnect
	handle.onDisconnect = () => {
		if (reElecting || !activeService || activeService.role !== "follower") return;
		clusterLog.info("leader disconnected, proactively re-electing");
		activeService = null;
		reElecting = initCluster(cachedParams!)
			.then(() => { reElecting = null; })
			.catch((err) => {
				reElecting = null;
				clusterLog.error("proactive re-election failed", { error: String(err) });
			});
	};

	async function withReconnect<T>(op: (p: EmbeddingProvider) => Promise<T>): Promise<T> {
		try {
			return await op(inner);
		} catch (err) {
			if (!isConnectionError(err)) throw err;
			if (reElecting) {
				clusterLog.debug("waiting for proactive re-election");
				await reElecting;
			} else {
				clusterLog.warn("leader lost, re-electing on demand", { error: String(err) });
				handle.close();
				activeService = null;
				await initCluster(cachedParams!);
			}
			if (!activeService) throw err;
			return op(activeService.embedding);
		}
	}

	const embedding: EmbeddingProvider = {
		id: inner.id,
		model: inner.model,
		embedQuery: (text) => withReconnect((p) => p.embedQuery(text)),
		embedBatch: (texts) => withReconnect((p) => p.embedBatch(texts)),
		dispose: async () => handle.close(),
	};

	// Connect bus over the same socket
	let bus: BusHandle | null = null;
	try {
		bus = await connectBus(handle.client, agentId, params.displayName);
	} catch (err) {
		clusterLog.warn("bus connect failed", { error: String(err) });
	}

	return {
		role: "follower",
		embedding,
		bus,
		async close() {
			if (bus) bus.close();
			handle.close();
			activeService = null;
		},
	};
}

function isConnectionError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const msg = err.message;
	return msg.includes("socket closed")
		|| msg.includes("socket error")
		|| msg.includes("client closed")
		|| msg.includes("EPIPE")
		|| msg.includes("ECONNRESET");
}