import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import lockfile from "proper-lockfile";

function normalizeScope(scope: string | undefined): string {
	const raw = scope?.trim() || "default";
	return raw.replace(/[^a-zA-Z0-9._-]/g, "_");
}

const CLUSTER_ROOT = join(homedir(), ".mono-pilot");

function socketPathFor(scope: string): string {
	return join(CLUSTER_ROOT, `cluster-v2.${scope}.sock`);
}

function lockPathFor(scope: string): string {
	return join(CLUSTER_ROOT, `cluster-v2.${scope}.leader`);
}

export function getSocketPath(scope?: string): string {
	return socketPathFor(normalizeScope(scope));
}

async function isSocketAlive(socketPath: string): Promise<boolean> {
	if (!existsSync(socketPath)) {
		return false;
	}

	return new Promise((resolve) => {
		const socket = net.createConnection(socketPath);
		const timer = setTimeout(() => {
			socket.destroy();
			resolve(false);
		}, 500);
		socket.on("connect", () => {
			clearTimeout(timer);
			socket.end();
			resolve(true);
		});
		socket.on("error", () => {
			clearTimeout(timer);
			resolve(false);
		});
	});
}

export function tryConnect(scope?: string, timeoutMs = 2000): Promise<net.Socket | null> {
	const socketPath = getSocketPath(scope);
	return new Promise((resolve) => {
		const socket = net.createConnection(socketPath);
		const timeout = setTimeout(() => {
			socket.destroy();
			resolve(null);
		}, timeoutMs);
		socket.on("connect", () => {
			clearTimeout(timeout);
			resolve(socket);
		});
		socket.on("error", () => {
			clearTimeout(timeout);
			resolve(null);
		});
	});
}

export interface LeaderConnectionHandle {
	socketPath: string;
	server: net.Server;
	close: () => Promise<void>;
}

export interface ListenOptions {
	scope?: string;
	staleMs?: number;
	updateMs?: number;
	onLeaseCompromised?: (error: Error) => void;
}

/**
 * Acquire leader lease and listen on scoped socket.
 * Returns null if lease is held by another process or listening fails.
 */
export async function tryListen(options?: ListenOptions): Promise<LeaderConnectionHandle | null> {
	const scope = normalizeScope(options?.scope);
	const socketPath = socketPathFor(scope);
	const lockPath = lockPathFor(scope);
	const stale = options?.staleMs ?? 10_000;
	const update = options?.updateMs ?? Math.max(1_000, Math.floor(stale / 2));

	mkdirSync(CLUSTER_ROOT, { recursive: true });
	writeFileSync(lockPath, "", { flag: "a" });

	let releaseLock: (() => Promise<void>) | null = null;
	try {
		releaseLock = await lockfile.lock(lockPath, {
			stale,
			update,
			retries: 0,
			onCompromised: (error) => {
				const compromisedError = error instanceof Error ? error : new Error(String(error));
				options?.onLeaseCompromised?.(compromisedError);
			},
		});
	} catch {
		return null;
	}

	if (existsSync(socketPath)) {
		const alive = await isSocketAlive(socketPath);
		if (alive) {
			await releaseLock();
			return null;
		}
		try {
			unlinkSync(socketPath);
		} catch {
			await releaseLock();
			return null;
		}
	}

	const server = net.createServer();
	const connections = new Set<net.Socket>();
	server.on("connection", (socket) => {
		connections.add(socket);
		socket.on("close", () => {
			connections.delete(socket);
		});
	});
	const listened = await new Promise<boolean>((resolve) => {
		server.once("error", () => resolve(false));
		server.listen(socketPath, () => resolve(true));
	});

	if (!listened) {
		try {
			server.close();
		} catch {
			// no-op
		}
		try {
			await releaseLock();
		} catch {
			// no-op
		}
		return null;
	}

	let closed = false;
	const close = async () => {
		if (closed) {
			return;
		}
		closed = true;

		for (const socket of connections) {
			socket.destroy();
		}

		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
		try {
			unlinkSync(socketPath);
		} catch {
			// no-op
		}
		if (releaseLock) {
			try {
				await releaseLock();
			} catch {
				// no-op
			}
		}
	};

	return {
		socketPath,
		server,
		close,
	};
}
