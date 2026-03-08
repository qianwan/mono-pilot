import type net from "node:net";
import {
	createClusterLogContext,
	logClusterEvent,
	RequestCounters,
	type ClusterLogContext,
	type RequestTerminalState,
} from "./observability.js";

/** Wire protocol for cluster_v2 IPC over Unix domain sockets. */

export const CLUSTER_V2_PROTOCOL_VERSION = 3;

export interface ClusterFrom {
	pid: number;
	agentId?: string;
	sessionId?: string;
}

export interface ClusterRequest {
	id: number;
	version: number;
	method: string;
	params: unknown;
	from?: ClusterFrom;
}

export interface ClusterResponse {
	id: number;
	result?: unknown;
	error?: string;
}

export interface ClusterPush {
	type: "push";
	method: string;
	payload: unknown;
}

export type ClusterMessage = ClusterRequest | ClusterResponse | ClusterPush;

export function isPush(msg: ClusterMessage): msg is ClusterPush {
	return "type" in msg && (msg as ClusterPush).type === "push";
}

export function isResponse(msg: ClusterMessage): msg is ClusterResponse {
	return !isPush(msg) && "id" in msg && !("method" in msg);
}

// --- Embedding RPC ---

export interface EmbedBatchParams {
	texts: string[];
}

export interface EmbedBatchResult {
	vectors: number[][];
}

// --- Registry RPC ---

export interface ServiceDescriptor {
	name: string;
	version: string;
	capabilities?: Record<string, unknown>;
}

// --- Bus RPC params ---

export interface RegisterParams {
	agentId: string;
	displayName?: string;
	channels?: string[];
}

export interface SendParams {
	to: string;
	channel?: string;
	payload: unknown;
}

export interface BroadcastParams {
	channel?: string;
	payload: unknown;
}

export interface SubscribeParams {
	channels: string[];
}

// --- Bus push payloads ---

export interface MessagePushPayload {
	from: string;
	fromName?: string;
	channel?: string;
	payload: unknown;
	seq: number;
}

export interface PresencePushPayload {
	agentId: string;
	displayName?: string;
	status: "joined" | "left";
}

// --- Framing ---

/** Encode as [4-byte little-endian length][utf8 JSON payload]. */
export function encodeMessage(msg: ClusterMessage): Buffer {
	const json = Buffer.from(JSON.stringify(msg), "utf8");
	const header = Buffer.alloc(4);
	header.writeUInt32LE(json.length, 0);
	return Buffer.concat([header, json]);
}

/** Incremental decoder for framed JSON stream. */
export class MessageDecoder {
	private buf = Buffer.alloc(0);

	feed(chunk: Buffer): ClusterMessage[] {
		this.buf = Buffer.concat([this.buf, chunk]);
		const messages: ClusterMessage[] = [];
		while (this.buf.length >= 4) {
			const len = this.buf.readUInt32LE(0);
			if (this.buf.length < 4 + len) {
				break;
			}
			const json = this.buf.subarray(4, 4 + len).toString("utf8");
			this.buf = this.buf.subarray(4 + len);
			messages.push(JSON.parse(json) as ClusterMessage);
		}
		return messages;
	}
}

interface PendingCall {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	method: string;
	abortCleanup?: () => void;
}

export interface RpcCallOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface RpcBackpressureOptions {
	maxInFlight?: number;
	maxQueue?: number;
}

interface RpcClientIdentity {
	agentId?: string;
	sessionId?: string;
	scope?: string;
	role?: string;
}

export class ClusterRpcClient {
	private nextId = 1;
	private pending = new Map<number, PendingCall>();
	private terminalStates = new Map<number, RequestTerminalState>();
	private readonly counters = new RequestCounters();
	private decoder = new MessageDecoder();
	private closed = false;
	private readonly from: ClusterFrom;
	private readonly logContext: ClusterLogContext;
	private disconnectHandlers = new Set<() => void>();
	private pushHandlers = new Map<string, Set<(payload: unknown) => void>>();

	constructor(
		private readonly socket: net.Socket,
		identity?: RpcClientIdentity,
	) {
		this.from = {
			pid: process.pid,
			agentId: identity?.agentId,
			sessionId: identity?.sessionId,
		};
		this.logContext = createClusterLogContext({
			agentId: identity?.agentId,
			sessionId: identity?.sessionId,
			scope: identity?.scope,
			role: identity?.role ?? "rpc_client",
		});

		socket.on("data", (chunk) => {
			const messages = this.decoder.feed(chunk);
			for (const msg of messages) {
				this.handleIncoming(msg);
			}
		});

		socket.on("error", () => {
			logClusterEvent("warn", "rpc_socket_error", this.logContext);
			this.abortAll("socket error");
		});

		socket.on("close", () => {
			logClusterEvent("info", "rpc_socket_closed", this.logContext);
			this.abortAll("socket closed");
			for (const handler of this.disconnectHandlers) {
				handler();
			}
		});
	}

	onDisconnect(handler: () => void): () => void {
		this.disconnectHandlers.add(handler);
		return () => {
			this.disconnectHandlers.delete(handler);
		};
	}

	/**
	 * Register push listener by method. Use "*" to receive all push methods.
	 */
	onPush(method: string, handler: (payload: unknown) => void): () => void {
		const current = this.pushHandlers.get(method) ?? new Set<(payload: unknown) => void>();
		current.add(handler);
		this.pushHandlers.set(method, current);
		return () => {
			const set = this.pushHandlers.get(method);
			if (!set) return;
			set.delete(handler);
			if (set.size === 0) {
				this.pushHandlers.delete(method);
			}
		};
	}

	call<T = unknown>(method: string, params: unknown, options?: RpcCallOptions): Promise<T> {
		if (this.closed) {
			return Promise.reject(new Error("client closed"));
		}

		const id = this.nextId++;
		const timeoutMs = options?.timeoutMs ?? 30_000;
		this.counters.start();

		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.markTerminal(id, "timeout", method);
				this.pending.delete(id);
				this.assertClientCounters("timeout");
				reject(new Error(`cluster_v2 RPC timeout: ${method}`));
			}, timeoutMs);

			let abortCleanup: (() => void) | undefined;
			if (options?.signal) {
				const onAbort = () => {
					this.markTerminal(id, "aborted", method);
					this.pending.delete(id);
					clearTimeout(timer);
					this.assertClientCounters("aborted");
					reject(new Error(`cluster_v2 RPC aborted: ${method}`));
				};
				if (options.signal.aborted) {
					onAbort();
					return;
				}
				options.signal.addEventListener("abort", onAbort, { once: true });
				abortCleanup = () => options.signal?.removeEventListener("abort", onAbort);
			}

			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					abortCleanup?.();
					resolve(value as T);
				},
				reject: (err) => {
					clearTimeout(timer);
					abortCleanup?.();
					reject(err);
				},
				timer,
				method,
				abortCleanup,
			});

			const request: ClusterRequest = {
				id,
				version: CLUSTER_V2_PROTOCOL_VERSION,
				method,
				params,
				from: this.from,
			};
			this.socket.write(encodeMessage(request));
			this.assertClientCounters("request_started");
		});
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		logClusterEvent("info", "rpc_client_close", this.logContext);
		this.socket.destroy();
		this.abortAll("client closed");
	}

	private handleIncoming(msg: ClusterMessage): void {
		if (isPush(msg)) {
			this.dispatchPush(msg.method, msg.payload);
			return;
		}

		const response = msg as ClusterResponse;
		const pending = this.pending.get(response.id);
		if (!pending) {
			if (!this.terminalStates.has(response.id)) {
				logClusterEvent("warn", "response_without_pending", this.logContext, {
					requestId: response.id,
				});
			}
			return;
		}
		this.pending.delete(response.id);
		if (response.error) {
			this.markTerminal(response.id, "error", pending.method);
			this.assertClientCounters("response_error");
			pending.reject(new Error(response.error));
			return;
		}
		this.markTerminal(response.id, "ok", pending.method);
		this.assertClientCounters("response_ok");
		pending.resolve(response.result);
	}

	private dispatchPush(method: string, payload: unknown): void {
		const direct = this.pushHandlers.get(method);
		if (direct) {
			for (const handler of direct) {
				handler(payload);
			}
		}
		const wildcard = this.pushHandlers.get("*");
		if (wildcard) {
			for (const handler of wildcard) {
				handler(payload);
			}
		}
	}

	private abortAll(reason: string): void {
		const terminalState: RequestTerminalState = reason.includes("closed") ? "closed" : "error";
		for (const [id, pending] of this.pending) {
			this.markTerminal(id, terminalState, pending.method);
			pending.reject(new Error(reason));
		}
		this.pending.clear();
		this.assertClientCounters("abort_all");
	}

	private markTerminal(id: number, state: RequestTerminalState, method: string): void {
		if (id < 0) {
			return;
		}
		const previous = this.terminalStates.get(id);
		if (previous && previous !== state) {
			logClusterEvent("warn", "request_terminalized_twice", this.logContext, {
				requestId: id,
				method,
				fromState: previous,
				toState: state,
			});
			return;
		}
		if (!previous) {
			this.terminalStates.set(id, state);
			this.counters.complete(state);
		}
		if (this.terminalStates.size > 2048) {
			const oldest = this.terminalStates.keys().next().value;
			if (typeof oldest === "number") {
				this.terminalStates.delete(oldest);
			}
		}
	}

	private assertClientCounters(source: string): void {
		this.counters.assertConsistency(this.pending.size, this.logContext, source);
	}
}

export interface RpcConnection {
	socket: net.Socket;
	state: Map<string, unknown>;
	sendPush: (method: string, payload: unknown) => void;
}

export type RpcRequestHandler = (request: ClusterRequest, connection: RpcConnection) => Promise<unknown>;

export function bindRpcConnection(
	socket: net.Socket,
	handler: RpcRequestHandler,
	options?: {
		onClose?: (connection: RpcConnection) => void;
		onError?: (error: Error) => void;
		backpressure?: RpcBackpressureOptions;
	},
): RpcConnection {
	const maxInFlight = options?.backpressure?.maxInFlight ?? 64;
	const maxQueue = options?.backpressure?.maxQueue ?? 256;
	let inFlight = 0;
	const queue: ClusterRequest[] = [];
	const serverContext = createClusterLogContext({ role: "rpc_server" });
	const counters = new RequestCounters();

	const updateServerContext = (request: ClusterRequest): void => {
		if (request.from?.agentId) {
			serverContext.agentId = request.from.agentId;
		}
		if (request.from?.sessionId) {
			serverContext.sessionId = request.from.sessionId;
		}
	};

	const assertRequestAccounting = (source: string, expectedOutstanding = inFlight + queue.length): void => {
		counters.assertConsistency(expectedOutstanding, serverContext, source);
	};

	const assertBackpressureBounds = () => {
		if (inFlight > maxInFlight || queue.length > maxQueue) {
			logClusterEvent("warn", "rpc_backpressure_bounds_exceeded", serverContext, {
				inFlight,
				maxInFlight,
				queued: queue.length,
				maxQueue,
			});
		}
	};

	const decoder = new MessageDecoder();
	const state = new Map<string, unknown>();
	const connection: RpcConnection = {
		socket,
		state,
		sendPush: (method, payload) => {
			if (socket.destroyed) {
				return;
			}
			socket.write(
				encodeMessage({
					type: "push",
					method,
					payload,
				}),
			);
		},
	};

	const executeRequest = (request: ClusterRequest) => {
		updateServerContext(request);
		inFlight++;
		assertBackpressureBounds();
		assertRequestAccounting("request_start");

		void (async () => {
			let terminalState: RequestTerminalState = "ok";
			try {
				const result = await handler(request, connection);
				if (!socket.destroyed) {
					socket.write(
						encodeMessage({
							id: request.id,
							result,
						}),
					);
				}
			} catch (error) {
				terminalState = "error";
				if (!socket.destroyed) {
					socket.write(
						encodeMessage({
							id: request.id,
							error: error instanceof Error ? error.message : String(error),
						}),
					);
				}
			} finally {
				counters.complete(terminalState);
				inFlight = Math.max(0, inFlight - 1);
				while (inFlight < maxInFlight && queue.length > 0) {
					const queued = queue.shift();
					if (!queued) {
						break;
					}
					executeRequest(queued);
				}
				assertBackpressureBounds();
				assertRequestAccounting("request_end");
			}
		})();
	};

	const enqueueOrExecute = (request: ClusterRequest) => {
		updateServerContext(request);
		counters.start();
		assertRequestAccounting("request_received", inFlight + queue.length + 1);
		if (queue.length > 0 || inFlight >= maxInFlight) {
			if (queue.length >= maxQueue) {
				counters.complete("error");
				socket.write(
					encodeMessage({
						id: request.id,
						error: `server overloaded: queue limit ${maxQueue} reached`,
					}),
				);
				assertRequestAccounting("queue_overload");
				return;
			}
			queue.push(request);
			assertBackpressureBounds();
			assertRequestAccounting("request_queued");
			return;
		}
		executeRequest(request);
	};

	socket.on("data", (chunk) => {
		const messages = decoder.feed(chunk);
		for (const msg of messages) {
			if (isPush(msg)) {
				continue;
			}

			const request = msg as ClusterRequest;
			if (request.version !== CLUSTER_V2_PROTOCOL_VERSION) {
				const response: ClusterResponse = {
					id: request.id,
					error: `unsupported protocol version: ${request.version}`,
				};
				socket.write(encodeMessage(response));
				continue;
			}

			enqueueOrExecute(request);
		}
	});

	socket.on("error", (error) => {
		logClusterEvent("warn", "rpc_server_socket_error", serverContext, {
			error: error instanceof Error ? error.message : String(error),
		});
		options?.onError?.(error instanceof Error ? error : new Error(String(error)));
	});

	socket.on("close", () => {
		if (queue.length > 0) {
			const dropped = queue.length;
			for (let i = 0; i < dropped; i++) {
				counters.complete("closed");
			}
			queue.length = 0;
			logClusterEvent("warn", "rpc_server_queue_dropped_on_close", serverContext, {
				dropped,
			});
		}
		assertRequestAccounting("socket_close");
		options?.onClose?.(connection);
	});

	return connection;
}
