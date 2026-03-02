import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type LogLevel = "debug" | "info" | "warn" | "error";

let resolveContext: () => Record<string, unknown> = () => ({});

/** Called internally by cluster init — not exported to consumers. */
export function setLogContext(resolve: () => Record<string, unknown>): void {
	resolveContext = resolve;
}

const LOGS_DIR = join(homedir(), ".mono-pilot", "logs");

function getLogPath(date = new Date()): string {
	const stamp = date.toISOString().slice(0, 10);
	return join(LOGS_DIR, `cluster.${stamp}.log`);
}

function formatLine(level: LogLevel, message: string, data?: Record<string, unknown>): string {
	const timestamp = new Date().toISOString();
	const merged = { pid: process.pid, ...resolveContext(), ...data };
	const payload = Object.keys(merged).length > 0 ? ` ${safeJson(merged)}` : "";
	return `${timestamp} [${level}] ${message}${payload}`;
}

function safeJson(data: Record<string, unknown>): string {
	try {
		return JSON.stringify(data);
	} catch {
		return "[unserializable]";
	}
}

let writeQueue: Promise<void> = Promise.resolve();

function enqueue(level: LogLevel, message: string, data?: Record<string, unknown>): void {
	const line = formatLine(level, message, data);
	writeQueue = writeQueue.then(async () => {
		await mkdir(LOGS_DIR, { recursive: true });
		await appendFile(getLogPath(), `${line}\n`, { encoding: "utf-8" });
	}).catch(() => {});
}

export const clusterLog = {
	debug(message: string, data?: Record<string, unknown>): void {
		enqueue("debug", message, data);
	},
	info(message: string, data?: Record<string, unknown>): void {
		enqueue("info", message, data);
	},
	warn(message: string, data?: Record<string, unknown>): void {
		enqueue("warn", message, data);
	},
	error(message: string, data?: Record<string, unknown>): void {
		enqueue("error", message, data);
	},
};