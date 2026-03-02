import { tryBecomeLeader, type LeaderHandle } from "./leader.js";
import { tryFollowLeader, type FollowerHandle, type FollowerIdentity } from "./follower.js";
import type { EmbeddingProvider } from "../memory/embeddings/types.js";
import { clusterLog } from "./log.js";
import { setLogContext } from "./log.js";

export interface ClusterEmbeddingService {
	role: "leader" | "follower";
	provider: EmbeddingProvider;
	close: () => Promise<void>;
}

let activeService: ClusterEmbeddingService | null = null;
let cachedParams: { modelPath?: string; modelCacheDir?: string } = {};
let reElecting: Promise<void> | null = null;

/**
 * Get a cluster-aware embedding provider.
 *
 * 1. If already initialized, return cached service.
 * 2. Try to connect as follower (leader already exists).
 * 3. If no leader, become the leader (load model locally).
 */
export async function getClusterEmbeddingService(params: {
	modelPath?: string;
	modelCacheDir?: string;
	agentId?: string;
	getSessionId?: () => string;
}): Promise<ClusterEmbeddingService> {
	if (activeService) {
		clusterLog.debug("returning cached service", { role: activeService.role });
		return activeService;
	}

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
		activeService = makeFollowerService(follower);
		return activeService;
	}

	// No leader — become one
	const leader = await tryBecomeLeader(params);
	if (leader) {
		clusterLog.info("resolved as leader");
		activeService = {
			role: "leader",
			provider: leader.provider,
			close: async () => {
				await leader.close();
				activeService = null;
			},
		};
		return activeService;
	}

	// Race condition: another process just became leader between our two attempts.
	// Retry as follower once.
	const retryFollower = await tryFollowLeader(modelId, identity);
	if (retryFollower) {
		clusterLog.info("resolved as follower (retry)");
		activeService = makeFollowerService(retryFollower);
		return activeService;
	}

	// Fallback: load model directly (no cluster)
	clusterLog.warn("cluster unavailable, loading model directly (standalone)");
	const { createLocalEmbeddingProvider } = await import("../memory/embeddings/local.js");
	const provider = await createLocalEmbeddingProvider(params);
	activeService = {
		role: "leader",
		provider,
		close: async () => {
			if (provider.dispose) await provider.dispose();
			activeService = null;
		},
	};
	return activeService;
}

/**
 * Shut down the active cluster service if any.
 */
export async function closeClusterEmbeddingService(): Promise<void> {
	if (activeService) {
		clusterLog.info("closing cluster service", { role: activeService.role });
		await activeService.close();
		activeService = null;
	}
}

/**
 * Wrap a follower handle with auto-promotion: if the leader dies mid-call,
 * re-run election (may become leader) and retry the failed operation once.
 */
function makeFollowerService(handle: FollowerHandle): ClusterEmbeddingService {
	const inner = handle.provider;

	// Proactive re-election: when leader drops, immediately start re-election
	// so the new provider is ready before the next call arrives.
	handle.onDisconnect = () => {
		if (reElecting || !activeService || activeService.role !== "follower") return;
		clusterLog.info("leader disconnected, proactively re-electing");
		activeService = null;
		reElecting = getClusterEmbeddingService(cachedParams)
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

			// If proactive re-election is already in progress, wait for it
			if (reElecting) {
				clusterLog.debug("waiting for proactive re-election");
				await reElecting;
			} else {
				clusterLog.warn("leader lost, re-electing on demand", { error: String(err) });
				handle.close();
				activeService = null;
				await getClusterEmbeddingService(cachedParams);
			}

			const newService = activeService;
			if (!newService) throw err;
			return op(newService.provider);
		}
	}

	const provider: EmbeddingProvider = {
		id: inner.id,
		model: inner.model,
		embedQuery: (text) => withReconnect((p) => p.embedQuery(text)),
		embedBatch: (texts) => withReconnect((p) => p.embedBatch(texts)),
		dispose: async () => handle.close(),
	};

	return {
		role: "follower",
		provider,
		close: async () => {
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