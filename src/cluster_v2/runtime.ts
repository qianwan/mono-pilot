import { createLocalEmbeddingProvider } from "../memory/embeddings/local.js";
import type { EmbeddingProvider } from "../memory/embeddings/types.js";
import { tryConnect, tryListen } from "./connection.js";
import { ConnectionLifecycleTracker } from "./connection-lifecycle.js";
import {
	ClusterRpcClient,
	bindRpcConnection,
	type ClusterRequest,
	type RpcConnection,
	type ServiceDescriptor,
} from "./rpc.js";
import { createClusterLogContext, logClusterEvent, type ClusterLogContext } from "./observability.js";
import { createEmbeddingClient, createEmbeddingHandlers } from "./services/embedding.js";
import { connectBusClient, createBusService, type BusHandle } from "./services/bus.js";
import { maybeStartDiscordCollector, type DiscordCollectorHandle } from "./services/discord/index.js";
import { FollowerRegistryCache } from "./services/registry-cache.js";
import { ServiceRegistry } from "./services/registry.js";

export interface ClusterV2Service {
	role: "leader" | "follower" | "standalone";
	embedding: EmbeddingProvider;
	bus: BusHandle | null;
	getServiceRegistrySnapshot(): Promise<{
		revision: number;
		services: ServiceDescriptor[];
	}>;
	close(): Promise<void>;
}

export interface ClusterV2InitParams {
	modelPath?: string;
	modelCacheDir?: string;
	agentId: string;
	displayName?: string;
	getSessionId?: () => string;
	scope?: string;
	rpcTimeoutMs?: number;
}

let activeService: ClusterV2Service | null = null;
let cachedParams: ClusterV2InitParams | null = null;
let reElecting: Promise<void> | null = null;
let initializingService: Promise<ClusterV2Service> | null = null;
const activeLeaderScopes = new Set<string>();

const DEFAULT_CLUSTER_V2_EMBEDDING_MAX_CONCURRENT_REQUESTS = 4;
const DEFAULT_CLUSTER_V2_EMBEDDING_MAX_TEXTS_PER_REQUEST = 16;
const DEFAULT_CLUSTER_V2_INIT_MAX_ATTEMPTS = 6;
const DEFAULT_CLUSTER_V2_INIT_RETRY_DELAY_MS = 100;

function parsePositiveIntegerEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) {
		return fallback;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return fallback;
	}
	return parsed;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getActiveClusterV2Service(): ClusterV2Service | null {
	return activeService;
}

function normalizeScope(scope: string | undefined): string {
	const raw = scope?.trim() || "default";
	return raw.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function transitionConnectionLifecycle(
	tracker: ConnectionLifecycleTracker,
	next: "disconnected" | "connecting" | "connected" | "reconnecting" | "closed",
	label: string,
	context: ClusterLogContext,
): void {
	const previous = tracker.state();
	tracker.transition(next, label);
	if (previous !== next) {
		logClusterEvent("info", "connection_lifecycle_transition", context, {
			fromState: previous,
			toState: next,
			label,
		});
	}
}

export async function initClusterV2(params: ClusterV2InitParams): Promise<ClusterV2Service> {
	if (activeService) {
		return activeService;
	}
	if (initializingService) {
		return initializingService;
	}

	initializingService = (async () => {
		cachedParams = params;
		const modelId = params.modelPath ?? "local";
		const sessionId = params.getSessionId?.();
		const scope = normalizeScope(params.scope);
		const initLogContext = createClusterLogContext({
			agentId: params.agentId,
			sessionId,
			scope,
			role: "runtime",
		});

		for (let attempt = 1; attempt <= DEFAULT_CLUSTER_V2_INIT_MAX_ATTEMPTS; attempt += 1) {
			const follower = await tryFollowAsClient(params, modelId, sessionId);
			if (follower) {
				activeService = follower;
				logClusterEvent("info", "runtime_role_selected", initLogContext, { role: follower.role });
				return follower;
			}

			const leader = await tryServeAsLeader(params);
			if (leader) {
				activeService = leader;
				logClusterEvent("info", "runtime_role_selected", initLogContext, { role: leader.role });
				return leader;
			}

			const retryFollower = await tryFollowAsClient(params, modelId, sessionId);
			if (retryFollower) {
				activeService = retryFollower;
				logClusterEvent("info", "runtime_role_selected", initLogContext, { role: retryFollower.role });
				return retryFollower;
			}

			if (attempt < DEFAULT_CLUSTER_V2_INIT_MAX_ATTEMPTS) {
				logClusterEvent("warn", "runtime_role_resolution_retry", initLogContext, {
					attempt,
					maxAttempts: DEFAULT_CLUSTER_V2_INIT_MAX_ATTEMPTS,
					retryDelayMs: DEFAULT_CLUSTER_V2_INIT_RETRY_DELAY_MS,
				});
				await sleep(DEFAULT_CLUSTER_V2_INIT_RETRY_DELAY_MS);
			}
		}

		const standaloneProvider = await createLocalEmbeddingProvider(params);
		activeService = {
			role: "standalone",
			embedding: standaloneProvider,
			bus: null,
			async getServiceRegistrySnapshot() {
				return {
					revision: 0,
					services: [
						{
							name: "embedding",
							version: "standalone",
							capabilities: { methods: ["embedding.embedBatch"] },
						},
					],
				};
			},
			async close() {
				if (standaloneProvider.dispose) {
					await standaloneProvider.dispose();
				}
				activeService = null;
			},
		};
		logClusterEvent("warn", "runtime_role_selected", initLogContext, { role: "standalone" });
		return activeService;
	})();

	try {
		return await initializingService;
	} finally {
		initializingService = null;
	}
}

export async function closeClusterV2(): Promise<void> {
	if (!activeService) {
		return;
	}
	logClusterEvent("info", "runtime_close", createClusterLogContext({ role: "runtime" }), {
		role: activeService.role,
	});
	await activeService.close();
	activeService = null;
}

export async function reelectClusterV2(): Promise<ClusterV2Service> {
	if (!cachedParams) {
		throw new Error("cluster_v2 is not initialized");
	}
	await closeClusterV2();
	return initClusterV2(cachedParams);
}

export async function stepdownClusterV2Leader(): Promise<ClusterV2Service> {
	if (!activeService) {
		throw new Error("cluster_v2 is not active");
	}
	if (activeService.role !== "leader") {
		throw new Error(`stepdown requires leader role, current role: ${activeService.role}`);
	}
	if (!cachedParams) {
		throw new Error("cluster_v2 is missing cached init params");
	}
	await closeClusterV2();
	return initClusterV2(cachedParams);
}

async function tryFollowAsClient(
	params: ClusterV2InitParams,
	modelId: string,
	sessionId?: string,
): Promise<ClusterV2Service | null> {
	const scope = normalizeScope(params.scope);
	const lifecycle = new ConnectionLifecycleTracker("disconnected");
	const logContext = createClusterLogContext({
		agentId: params.agentId,
		sessionId,
		scope,
		role: "follower",
	});

	transitionConnectionLifecycle(lifecycle, "connecting", "tryFollowAsClient:start", logContext);
	const socket = await tryConnect(params.scope);
	if (!socket) {
		transitionConnectionLifecycle(lifecycle, "disconnected", "tryFollowAsClient:no_socket", logContext);
		return null;
	}
	transitionConnectionLifecycle(lifecycle, "connected", "tryFollowAsClient:connected", logContext);
	lifecycle.assertOpenImpliesConnected(!socket.destroyed, "tryFollowAsClient:connected");

	const client = new ClusterRpcClient(socket, {
		agentId: params.agentId,
		sessionId,
		scope,
		role: "rpc_client_follower",
	});

	try {
		const pong = await client.call<string>("cluster.ping", null, { timeoutMs: 3000 });
		if (pong !== "pong") {
			client.close();
			transitionConnectionLifecycle(lifecycle, "disconnected", "tryFollowAsClient:ping_mismatch", logContext);
			return null;
		}
	} catch {
		client.close();
		transitionConnectionLifecycle(lifecycle, "disconnected", "tryFollowAsClient:ping_failed", logContext);
		return null;
	}

	const registryCache = new FollowerRegistryCache(client, logContext);
	try {
		await registryCache.refresh();
		await registryCache.requireService("embedding");
	} catch (error) {
		logClusterEvent("warn", "registry_bootstrap_failed", logContext, {
			error: error instanceof Error ? error.message : String(error),
		});
		registryCache.invalidate("bootstrap_failed");
		client.close();
		transitionConnectionLifecycle(lifecycle, "disconnected", "tryFollowAsClient:registry_failed", logContext);
		return null;
	}

	const baseEmbedding = createEmbeddingClient(client, {
		model: modelId,
		timeoutMs: params.rpcTimeoutMs,
	});

	const embedding: EmbeddingProvider = {
		id: baseEmbedding.id,
		model: baseEmbedding.model,
		embedQuery: (text) => withReconnect(baseEmbedding, (p) => p.embedQuery(text)),
		embedBatch: (texts) => withReconnect(baseEmbedding, (p) => p.embedBatch(texts)),
		dispose: async () => {
			client.close();
		},
	};

	let bus: BusHandle | null = null;
	try {
		await registryCache.requireService("bus");
		bus = await connectBusClient(client, params.agentId, params.displayName);
	} catch (error) {
		logClusterEvent("warn", "bus_service_unavailable", logContext, {
			error: error instanceof Error ? error.message : String(error),
			cacheRevision: registryCache.currentRevision(),
		});
		registryCache.invalidate("bus_unavailable");
		client.close();
		transitionConnectionLifecycle(lifecycle, "disconnected", "tryFollowAsClient:bus_unavailable", logContext);
		return null;
	}

	const detachDisconnect = client.onDisconnect(() => {
		if (reElecting || !activeService || activeService.role !== "follower" || !cachedParams) {
			return;
		}
		registryCache.invalidate("leader_disconnect");
		transitionConnectionLifecycle(lifecycle, "reconnecting", "follower_disconnect", logContext);
		lifecycle.assertOpenImpliesConnected(!socket.destroyed, "follower_disconnect");
		logClusterEvent("warn", "follower_disconnected_re_elect", logContext);
		activeService = null;
		reElecting = initClusterV2(cachedParams)
			.then(() => {
				transitionConnectionLifecycle(lifecycle, "disconnected", "re_elect_complete", logContext);
				reElecting = null;
			})
			.catch(() => {
				transitionConnectionLifecycle(lifecycle, "disconnected", "re_elect_failed", logContext);
				reElecting = null;
			});
	});

	return {
		role: "follower",
		embedding,
		bus,
		async getServiceRegistrySnapshot() {
			return client.call<{ revision: number; services: ServiceDescriptor[] }>("registry.list", {});
		},
		async close() {
			detachDisconnect();
			if (bus) {
				bus.close();
			}
			registryCache.invalidate("follower_close");
			client.close();
			transitionConnectionLifecycle(lifecycle, "closed", "follower_close", logContext);
			lifecycle.assertOpenImpliesConnected(!socket.destroyed, "follower_close");
			activeService = null;
		},
	};
}

async function withReconnect<T>(
	inner: EmbeddingProvider,
	op: (provider: EmbeddingProvider) => Promise<T>,
): Promise<T> {
	try {
		return await op(inner);
	} catch (error) {
		if (!isConnectionError(error) || !cachedParams) {
			throw error;
		}

		if (reElecting) {
			await reElecting;
		} else {
			activeService = null;
			await initClusterV2(cachedParams);
		}

		if (!activeService) {
			throw error;
		}
		return op(activeService.embedding);
	}
}

async function tryServeAsLeader(params: ClusterV2InitParams): Promise<ClusterV2Service | null> {
	const leaderScope = normalizeScope(params.scope);
	const lifecycle = new ConnectionLifecycleTracker("disconnected");
	const sessionId = params.getSessionId?.();
	const logContext = createClusterLogContext({
		agentId: params.agentId,
		sessionId,
		scope: leaderScope,
		role: "leader",
	});
	let leaseCompromised = false;
	let leaseCompromisedError: Error | null = null;
	let handleLeaseCompromised: (() => void) | null = null;
	let closingLeader = false;

	if (activeLeaderScopes.has(leaderScope)) {
		logClusterEvent("warn", "leader_guard_precheck_failed", logContext, {
			leaderScope,
		});
		throw new Error(`[cluster_v2/runtime] leader guard violated for scope: ${leaderScope}`);
	}

	const provider = await createLocalEmbeddingProvider(params);

	transitionConnectionLifecycle(lifecycle, "connecting", "tryServeAsLeader:start", logContext);
	const connection = await tryListen({
		scope: params.scope,
		onLeaseCompromised: (error) => {
			leaseCompromised = true;
			leaseCompromisedError = error;
			logClusterEvent("warn", "leader_lease_compromised", logContext, {
				error: error.message,
				leaderScope,
			});
			handleLeaseCompromised?.();
		},
	});
	if (!connection) {
		transitionConnectionLifecycle(lifecycle, "disconnected", "tryServeAsLeader:listen_failed", logContext);
		if (provider.dispose) {
			await provider.dispose();
		}
		return null;
	}
	transitionConnectionLifecycle(lifecycle, "connected", "tryServeAsLeader:listening", logContext);
	lifecycle.assertOpenImpliesConnected(connection.server.listening, "tryServeAsLeader:listening");

	if (leaseCompromised) {
		await connection.close();
		if (provider.dispose) {
			await provider.dispose();
		}
		transitionConnectionLifecycle(lifecycle, "closed", "leader_lease_compromised_before_activate", logContext);
		return null;
	}

	if (activeLeaderScopes.has(leaderScope)) {
		await connection.close();
		if (provider.dispose) {
			await provider.dispose();
		}
		transitionConnectionLifecycle(lifecycle, "closed", "leader_guard_race_failed", logContext);
		logClusterEvent("warn", "leader_guard_race_failed", logContext, {
			leaderScope,
		});
		throw new Error(`[cluster_v2/runtime] leader guard violated for scope: ${leaderScope}`);
	}
	activeLeaderScopes.add(leaderScope);
	logClusterEvent("info", "leader_scope_activated", logContext, { leaderScope });

	const busService = createBusService();
	const embeddingHandlers = createEmbeddingHandlers(provider, {
		maxConcurrentRequests: parsePositiveIntegerEnv(
			"MONO_PILOT_CLUSTER_V2_EMBEDDING_MAX_CONCURRENCY",
			DEFAULT_CLUSTER_V2_EMBEDDING_MAX_CONCURRENT_REQUESTS,
		),
		maxTextsPerRequest: parsePositiveIntegerEnv(
			"MONO_PILOT_CLUSTER_V2_EMBEDDING_MAX_TEXTS_PER_REQUEST",
			DEFAULT_CLUSTER_V2_EMBEDDING_MAX_TEXTS_PER_REQUEST,
		),
	});

	let discordCollector: DiscordCollectorHandle | null = null;
	try {
		discordCollector = await maybeStartDiscordCollector(logContext);
	} catch (error) {
		logClusterEvent("warn", "discord_collector_start_failed", logContext, {
			error: error instanceof Error ? error.message : String(error),
		});
		discordCollector = null;
	}

	const extraServices: ServiceDescriptor[] = [];
	if (discordCollector) {
		extraServices.push(discordCollector.descriptor);
	}

	const registry = new ServiceRegistry();
	registerDefaultServices(registry, extraServices);

	const handlers: Record<string, (request: ClusterRequest, connection: RpcConnection) => Promise<unknown>> = {
		"cluster.ping": async () => "pong",
		"registry.list": async () => registry.snapshot(),
		"registry.resolve": async (request) => {
			const name = (request.params as { name?: unknown } | null)?.name;
			if (!name || typeof name !== "string") {
				throw new Error("registry.resolve requires string name");
			}
			const service = registry.resolve(name);
			return { revision: registry.getRevision(), service };
		},
		...embeddingHandlers,
		...busService.handlers,
	};

	connection.server.on("connection", (socket) => {
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

	const bus = busService.createLeaderHandle(params.agentId, params.displayName);

	const closeLeaderResources = async (reason: string): Promise<void> => {
		if (closingLeader) {
			return;
		}
		closingLeader = true;
		activeLeaderScopes.delete(leaderScope);
		if (discordCollector) {
			await discordCollector.close();
			discordCollector = null;
		}
		bus.close();
		await connection.close();
		transitionConnectionLifecycle(lifecycle, "closed", `leader_close:${reason}`, logContext);
		lifecycle.assertOpenImpliesConnected(connection.server.listening, `leader_close:${reason}`);
		logClusterEvent("info", "leader_scope_released", logContext, { leaderScope, reason });
		if (provider.dispose) {
			await provider.dispose();
		}
		activeService = null;
	};

	handleLeaseCompromised = () => {
		if (closingLeader) {
			return;
		}
		void (async () => {
			await closeLeaderResources("lease_compromised");
			if (!cachedParams || reElecting) {
				return;
			}
			reElecting = initClusterV2(cachedParams)
				.then(() => {
					reElecting = null;
				})
				.catch((error) => {
					logClusterEvent("warn", "leader_lease_compromise_re_elect_failed", logContext, {
						error: error instanceof Error ? error.message : String(error),
						leaseError: leaseCompromisedError?.message,
					});
					reElecting = null;
				});
		})();
	};

	if (leaseCompromised) {
		await closeLeaderResources("lease_compromised_pre_activate");
		return null;
	}

	return {
		role: "leader",
		embedding: provider,
		bus,
		async getServiceRegistrySnapshot() {
			return registry.snapshot();
		},
		async close() {
			await closeLeaderResources("explicit_close");
		},
	};
}

function registerDefaultServices(registry: ServiceRegistry, extras?: ServiceDescriptor[]): void {
	const services: ServiceDescriptor[] = [
		{ name: "embedding", version: "v2", capabilities: { methods: ["embedding.embedBatch"] } },
		{
			name: "bus",
			version: "v2",
			capabilities: {
				methods: ["bus.register", "bus.subscribe", "bus.send", "bus.broadcast", "bus.roster"],
			},
		},
		...(extras ?? []),
	];
	for (const service of services) {
		registry.register(service);
	}
}

function isConnectionError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const message = error.message;
	return (
		message.includes("socket closed") ||
		message.includes("socket error") ||
		message.includes("client closed") ||
		message.includes("timeout") ||
		message.includes("EPIPE") ||
		message.includes("ECONNRESET")
	);
}
