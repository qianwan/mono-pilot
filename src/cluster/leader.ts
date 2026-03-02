/**
 * Cluster leader: transport layer with pluggable service handlers.
 *
 * Owns the Unix domain socket server, connection lifecycle, and request dispatch.
 * Business logic lives in service handlers (src/cluster/services/).
 */
import type net from "node:net";
import { tryListen, cleanupSocket } from "./socket.js";
import {
	CLUSTER_PROTOCOL_VERSION,
	encodeMessage,
	MessageDecoder,
	type ClusterRequest,
	type ClusterResponse,
} from "./protocol.js";
import { clusterLog } from "./log.js";

// --- Service handler interface ---

/** Context passed to service handlers for each request. */
export interface RequestContext {
	socket: net.Socket;
	respond(res: Omit<ClusterResponse, "id">): void;
	getRegisteredId(): string | undefined;
	setRegisteredId(id: string): void;
}

/** Pluggable service that handles a set of RPC methods on the leader. */
export interface ServiceHandler {
	/** RPC method names this service handles. */
	methods: string[];
	/** Handle an incoming request. */
	handle(req: ClusterRequest, ctx: RequestContext): Promise<void>;
	/** Called when a registered follower disconnects. */
	onDisconnect?(agentId: string): void;
}

// --- Leader ---

export interface LeaderHandle {
	close: () => Promise<void>;
}

/**
 * Try to become the cluster leader.
 *
 * Registers the given service handlers and dispatches incoming requests.
 * Returns a LeaderHandle on success, or null if another leader is already running.
 */
export async function tryBecomeLeader(
	services: ServiceHandler[],
	onClose?: () => Promise<void>,
): Promise<LeaderHandle | null> {
	const server = await tryListen();
	if (!server) {
		clusterLog.debug("leader election lost (socket in use)");
		return null;
	}

	// Build method → handler dispatch table
	const dispatch = new Map<string, ServiceHandler>();
	for (const svc of services) {
		for (const m of svc.methods) dispatch.set(m, svc);
	}

	clusterLog.info("became leader", { methods: [...dispatch.keys()] });

	server.on("connection", (socket) => {
		clusterLog.info("follower connected", { remote: socket.remoteAddress ?? "unknown" });
		handleConnection(socket, dispatch, services);
	});

	const close = async () => {
		clusterLog.info("leader shutting down");
		server.close();
		cleanupSocket();
		if (onClose) await onClose();
	};

	const onExit = () => { server.close(); cleanupSocket(); };
	process.on("exit", onExit);
	process.on("SIGINT", onExit);
	process.on("SIGTERM", onExit);

	return { close };
}

function handleConnection(
	socket: net.Socket,
	dispatch: Map<string, ServiceHandler>,
	services: ServiceHandler[],
): void {
	const decoder = new MessageDecoder();
	let registeredId: string | undefined;

	const ctx: RequestContext = {
		socket,
		respond: () => {},  // overwritten per request
		getRegisteredId: () => registeredId,
		setRegisteredId: (id) => { registeredId = id; },
	};

	socket.on("data", (chunk) => {
		for (const msg of decoder.feed(chunk)) {
			void routeRequest(msg as ClusterRequest, ctx, dispatch);
		}
	});

	const cleanup = () => {
		if (registeredId) {
			for (const svc of services) svc.onDisconnect?.(registeredId);
			registeredId = undefined;
		}
	};

	socket.on("error", (err) => {
		clusterLog.debug("follower socket error", { error: String(err) });
		cleanup();
	});
	socket.on("close", cleanup);
}

async function routeRequest(
	req: ClusterRequest,
	baseCtx: RequestContext,
	dispatch: Map<string, ServiceHandler>,
): Promise<void> {
	// Per-request respond bound to this req.id
	const respond = (res: Omit<ClusterResponse, "id">) => {
		if (!baseCtx.socket.destroyed) {
			baseCtx.socket.write(encodeMessage({ id: req.id, ...res }));
		}
	};
	const ctx: RequestContext = { ...baseCtx, respond };

	if (req.version !== CLUSTER_PROTOCOL_VERSION) {
		clusterLog.warn("protocol version mismatch", { expected: CLUSTER_PROTOCOL_VERSION, got: req.version });
		respond({ error: `unsupported protocol version: ${req.version}` });
		return;
	}

	if (req.method === "ping") {
		respond({ result: "pong" });
		return;
	}

	const handler = dispatch.get(req.method);
	if (!handler) {
		clusterLog.warn("unknown method", { method: req.method, reqId: req.id });
		respond({ error: `unknown method: ${req.method}` });
		return;
	}

	try {
		await handler.handle(req, ctx);
	} catch (err) {
		clusterLog.error("handler error", { method: req.method, reqId: req.id, error: err instanceof Error ? err.message : String(err) });
		respond({ error: err instanceof Error ? err.message : String(err) });
	}
}