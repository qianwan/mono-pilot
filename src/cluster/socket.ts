import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import net from "node:net";
import { clusterLog } from "./log.js";

const MONO_PILOT_DIR = join(homedir(), ".mono-pilot");
const SOCKET_PATH = join(MONO_PILOT_DIR, "cluster.sock");

export function getSocketPath(): string {
	return SOCKET_PATH;
}

/**
 * Try to connect to an existing cluster leader.
 * Returns the socket on success, or null if no leader is listening.
 */
export function tryConnect(): Promise<net.Socket | null> {
	return new Promise((resolve) => {
		const socket = net.createConnection(SOCKET_PATH);
		const timeout = setTimeout(() => {
			socket.destroy();
			resolve(null);
		}, 2000);

		socket.on("connect", () => {
			clearTimeout(timeout);
			resolve(socket);
		});
		socket.on("error", () => {
			clearTimeout(timeout);
			cleanStaleSocket();
			resolve(null);
		});
	});
}

/**
 * Try to start listening as leader.
 * If a socket file exists but no leader is alive, clean it up and proceed.
 */
export async function tryListen(): Promise<net.Server | null> {
	mkdirSync(MONO_PILOT_DIR, { recursive: true });

	if (existsSync(SOCKET_PATH)) {
		const alive = await isSocketAlive();
		if (alive) {
			return null;
		}
		clusterLog.info("cleaning stale socket before listen");
		cleanStaleSocket();
	}

	return new Promise((resolve) => {
		const server = net.createServer();

		server.on("error", (err: NodeJS.ErrnoException) => {
			clusterLog.debug("listen failed", { code: err.code });
			resolve(null);
		});

		server.listen(SOCKET_PATH, () => {
			resolve(server);
		});
	});
}

/**
 * Check if something is actually listening on the socket.
 */
function isSocketAlive(): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.createConnection(SOCKET_PATH);
		const timeout = setTimeout(() => {
			socket.destroy();
			resolve(false);
		}, 1000);
		socket.on("connect", () => {
			clearTimeout(timeout);
			socket.destroy();
			resolve(true);
		});
		socket.on("error", () => {
			clearTimeout(timeout);
			resolve(false);
		});
	});
}

/**
 * Remove a stale socket file left behind by a crashed leader.
 */
function cleanStaleSocket(): void {
	try {
		if (existsSync(SOCKET_PATH)) {
			unlinkSync(SOCKET_PATH);
		}
	} catch {
		// May have been cleaned up by another process
	}
}

/**
 * Clean up socket file on leader shutdown.
 */
export function cleanupSocket(): void {
	try {
		unlinkSync(SOCKET_PATH);
	} catch {
		// Ignore
	}
}