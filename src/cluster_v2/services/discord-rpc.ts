import { randomUUID } from "node:crypto";
import net from "node:net";
import { EventEmitter } from "node:events";

const OPCODE_HANDSHAKE = 0;
const OPCODE_FRAME = 1;
const OPCODE_CLOSE = 2;
const OPCODE_PING = 3;
const OPCODE_PONG = 4;

const DEFAULT_MAX_IPC_ID = 10;
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const AUTHORIZE_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 10_000;

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

interface ReadyWaiter {
	resolve: () => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

interface DiscordRpcEnvelope {
	cmd?: string;
	evt?: string;
	nonce?: string;
	args?: unknown;
	data?: unknown;
}

interface DecodedFrame {
	op: number;
	data: unknown;
}

interface ConnectOptions {
	maxIpcId?: number;
	timeoutMs?: number;
}

export interface DiscordRpcClientOptions {
	clientId: string;
	connect?: ConnectOptions;
}

export interface DiscordAuthorizeOptions {
	prompt?: string;
	rpcToken?: string;
}

export interface DiscordRpcChannelInfo {
	id: string;
	name: string | null;
	guildId: string | null;
}

export interface DiscordRpcGuildInfo {
	id: string;
	name: string | null;
}

function getIpcPath(id: number): string {
	if (process.platform === "win32") {
		return `\\\\?\\pipe\\discord-ipc-${id}`;
	}

	const { XDG_RUNTIME_DIR, TMPDIR, TMP, TEMP } = process.env;
	const prefix = XDG_RUNTIME_DIR || TMPDIR || TMP || TEMP || "/tmp";
	return `${prefix.replace(/\/$/, "")}/discord-ipc-${id}`;
}

function encodeFrame(op: number, payload: unknown): Buffer {
	const json = Buffer.from(JSON.stringify(payload), "utf8");
	const packet = Buffer.alloc(8 + json.length);
	packet.writeInt32LE(op, 0);
	packet.writeInt32LE(json.length, 4);
	json.copy(packet, 8);
	return packet;
}

class FrameDecoder {
	private buffer = Buffer.alloc(0);

	feed(chunk: Buffer): DecodedFrame[] {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		const frames: DecodedFrame[] = [];

		while (this.buffer.length >= 8) {
			const op = this.buffer.readInt32LE(0);
			const len = this.buffer.readInt32LE(4);
			if (len < 0 || len > MAX_FRAME_BYTES) {
				throw new Error(`invalid discord ipc frame length: ${len}`);
			}
			if (this.buffer.length < 8 + len) {
				break;
			}

			const json = this.buffer.subarray(8, 8 + len).toString("utf8");
			this.buffer = this.buffer.subarray(8 + len);
			frames.push({ op, data: JSON.parse(json) });
		}

		return frames;
	}
}

async function connectSocket(options?: ConnectOptions): Promise<net.Socket> {
	const maxIpcId = options?.maxIpcId ?? DEFAULT_MAX_IPC_ID;
	const timeoutMs = options?.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

	let lastError: Error | null = null;
	for (let id = 0; id <= maxIpcId; id += 1) {
		const socketPath = getIpcPath(id);
		try {
			const socket = await new Promise<net.Socket>((resolve, reject) => {
				const socket = net.createConnection(socketPath);
				const timer = setTimeout(() => {
					socket.destroy();
					reject(new Error(`discord ipc connect timeout: ${socketPath}`));
				}, timeoutMs);

				socket.once("connect", () => {
					clearTimeout(timer);
					resolve(socket);
				});

				socket.once("error", (error) => {
					clearTimeout(timer);
					reject(error instanceof Error ? error : new Error(String(error)));
				});
			});

			socket.setNoDelay(true);
			return socket;
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}
	}

	throw lastError ?? new Error("unable to connect to discord ipc socket");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

export class DiscordRpcClient {
	private socket: net.Socket | null = null;
	private readonly decoder = new FrameDecoder();
	private readonly pending = new Map<string, PendingRequest>();
	private readonly emitter = new EventEmitter();
	private ready = false;
	private readonly readyWaiters = new Set<ReadyWaiter>();

	constructor(private readonly options: DiscordRpcClientOptions) {}

	async connect(): Promise<void> {
		if (this.socket && !this.socket.destroyed) {
			if (!this.ready) {
				await this.waitForReady();
			}
			return;
		}

		const socket = await connectSocket(this.options.connect);
		this.socket = socket;
		this.ready = false;

		socket.on("data", (chunk) => {
			try {
				const frames = this.decoder.feed(chunk);
				for (const frame of frames) {
					this.handleFrame(frame);
				}
			} catch (error) {
				this.failPending(
					error instanceof Error ? error : new Error(String(error)),
				);
				this.shutdownSocket();
			}
		});

		socket.on("error", (error) => {
			this.failPending(error instanceof Error ? error : new Error(String(error)));
			this.shutdownSocket();
		});

		socket.on("close", () => {
			this.failPending(new Error("discord ipc socket closed"));
			this.shutdownSocket();
		});

		socket.write(
			encodeFrame(OPCODE_HANDSHAKE, {
				v: 1,
				client_id: this.options.clientId,
			}),
		);

		await this.waitForReady();
	}

	async authenticate(accessToken: string): Promise<void> {
		await this.request("AUTHENTICATE", { access_token: accessToken });
	}

	async authorize(scopes: string[], options?: DiscordAuthorizeOptions): Promise<{ code: string }> {
		const result = await this.request("AUTHORIZE", {
			client_id: this.options.clientId,
			scopes,
			prompt: options?.prompt,
			rpc_token: options?.rpcToken,
		}, undefined, AUTHORIZE_TIMEOUT_MS);

		if (!isRecord(result) || typeof result.code !== "string" || result.code.length === 0) {
			throw new Error("discord rpc authorize did not return code");
		}

		return { code: result.code };
	}

	async subscribe(eventName: string, args?: Record<string, unknown>): Promise<void> {
		await this.request("SUBSCRIBE", args ?? {}, eventName);
	}

	async getChannel(channelId: string): Promise<DiscordRpcChannelInfo> {
		const result = await this.request("GET_CHANNEL", { channel_id: channelId });
		if (!isRecord(result)) {
			throw new Error("discord rpc GET_CHANNEL returned invalid payload");
		}
		const id = readString(result.id);
		if (!id) {
			throw new Error("discord rpc GET_CHANNEL missing channel id");
		}

		return {
			id,
			name: readString(result.name),
			guildId: readString(result.guild_id),
		};
	}

	async getGuild(guildId: string): Promise<DiscordRpcGuildInfo> {
		const result = await this.request("GET_GUILD", { guild_id: guildId });
		if (!isRecord(result)) {
			throw new Error("discord rpc GET_GUILD returned invalid payload");
		}
		const id = readString(result.id);
		if (!id) {
			throw new Error("discord rpc GET_GUILD missing guild id");
		}

		return {
			id,
			name: readString(result.name),
		};
	}

	onEvent(eventName: string, handler: (payload: unknown) => void): () => void {
		this.emitter.on(`event:${eventName}`, handler);
		return () => {
			this.emitter.off(`event:${eventName}`, handler);
		};
	}

	onDisconnected(handler: () => void): () => void {
		this.emitter.on("disconnected", handler);
		return () => {
			this.emitter.off("disconnected", handler);
		};
	}

	async waitForDisconnect(): Promise<void> {
		if (!this.socket || this.socket.destroyed) {
			return;
		}

		await new Promise<void>((resolve) => {
			const off = this.onDisconnected(() => {
				off();
				resolve();
			});
		});
	}

	close(): void {
		this.failPending(new Error("discord rpc client closed"));
		this.shutdownSocket();
	}

	private async request(
		cmd: string,
		args?: unknown,
		evt?: string,
		timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
	): Promise<unknown> {
		const socket = this.socket;
		if (!socket || socket.destroyed) {
			throw new Error("discord ipc socket is not connected");
		}

		const nonce = randomUUID();
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(nonce);
				reject(new Error(`discord rpc timeout: ${cmd}`));
			}, timeoutMs);

			this.pending.set(nonce, { resolve, reject, timer });
			socket.write(
				encodeFrame(OPCODE_FRAME, {
					cmd,
					args,
					evt,
					nonce,
				}),
			);
		});
	}

	private handleFrame(frame: DecodedFrame): void {
		if (frame.op === OPCODE_PING) {
			this.socket?.write(encodeFrame(OPCODE_PONG, frame.data));
			return;
		}

		if (frame.op === OPCODE_CLOSE) {
			this.shutdownSocket();
			return;
		}

		if (frame.op !== OPCODE_FRAME || !isRecord(frame.data)) {
			return;
		}

		const envelope = frame.data as DiscordRpcEnvelope;
		const nonce = typeof envelope.nonce === "string" ? envelope.nonce : undefined;
		if (nonce && this.pending.has(nonce)) {
			const pending = this.pending.get(nonce);
			if (!pending) {
				return;
			}
			this.pending.delete(nonce);
			clearTimeout(pending.timer);
			if (envelope.evt === "ERROR") {
				const message =
					isRecord(envelope.data) && typeof envelope.data.message === "string"
						? envelope.data.message
						: "discord rpc command failed";
				pending.reject(new Error(message));
				return;
			}
			pending.resolve(envelope.data);
			return;
		}

		if (envelope.cmd === "DISPATCH" && typeof envelope.evt === "string") {
			if (envelope.evt === "READY") {
				this.markReady();
			}
			this.emitter.emit(`event:${envelope.evt}`, envelope.data);
		}
	}

	private waitForReady(timeoutMs = READY_TIMEOUT_MS): Promise<void> {
		if (this.ready) {
			return Promise.resolve();
		}

		return new Promise<void>((resolve, reject) => {
			const waiter: ReadyWaiter = {
				resolve: () => {
					clearTimeout(waiter.timer);
					this.readyWaiters.delete(waiter);
					resolve();
				},
				reject: (error) => {
					clearTimeout(waiter.timer);
					this.readyWaiters.delete(waiter);
					reject(error);
				},
				timer: setTimeout(() => {
					this.readyWaiters.delete(waiter);
					reject(new Error("discord rpc timeout: READY"));
				}, timeoutMs),
			};
			this.readyWaiters.add(waiter);
		});
	}

	private markReady(): void {
		if (this.ready) {
			return;
		}
		this.ready = true;
		for (const waiter of this.readyWaiters) {
			waiter.resolve();
		}
		this.readyWaiters.clear();
	}

	private failPending(error: Error): void {
		for (const [nonce, pending] of this.pending.entries()) {
			this.pending.delete(nonce);
			clearTimeout(pending.timer);
			pending.reject(error);
		}
	}

	private shutdownSocket(): void {
		const socket = this.socket;
		this.ready = false;
		for (const waiter of this.readyWaiters) {
			waiter.reject(new Error("discord ipc socket closed before READY"));
		}
		this.readyWaiters.clear();
		if (!socket) {
			return;
		}
		this.socket = null;
		if (!socket.destroyed) {
			socket.destroy();
		}
		this.emitter.emit("disconnected");
	}
}