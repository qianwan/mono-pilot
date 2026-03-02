import { homedir } from "node:os";
import { join } from "node:path";
import { unlinkSync, mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import lockfile from "proper-lockfile";
import { clusterLog } from "./log.js";

const MONO_PILOT_DIR = join(homedir(), ".mono-pilot");
const SOCKET_PATH = join(MONO_PILOT_DIR, "cluster.sock");
const LOCK_FILE = join(MONO_PILOT_DIR, "cluster.leader");

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
			resolve(null);
		});
	});
}

/**
 * Try to become leader: acquire file lock, clean stale socket, listen.
 * Uses proper-lockfile (mkdir + mtime heartbeat) for atomic, crash-safe locking.
 */
export async function tryListen(): Promise<net.Server | null> {
	mkdirSync(MONO_PILOT_DIR, { recursive: true });
	writeFileSync(LOCK_FILE, "", { flag: "a" });

	try {
		await lockfile.lock(LOCK_FILE, {
			stale: 10000, // lock considered stale after 10s without heartbeat
			retries: 0,
			onCompromised: (err) => {
				clusterLog.warn("leader lock compromised", { error: String(err) });
			},
		});
	} catch {
		clusterLog.debug("leader lock held by another process");
		return null;
	}

	// We hold the lock — safe to clean stale socket file
	try { unlinkSync(SOCKET_PATH); } catch {}

	return new Promise((resolve) => {
		const server = net.createServer();
		server.on("error", (err: NodeJS.ErrnoException) => {
			clusterLog.debug("listen failed", { code: err.code });
			try { lockfile.unlockSync(LOCK_FILE); } catch {}
			resolve(null);
		});
		server.listen(SOCKET_PATH, () => {
			resolve(server);
		});
	});
}

/**
 * Clean up socket and release lock on leader shutdown.
 */
export function cleanupSocket(): void {
	try { unlinkSync(SOCKET_PATH); } catch {}
	try { lockfile.unlockSync(LOCK_FILE); } catch {}
}