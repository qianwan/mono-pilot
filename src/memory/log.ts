import { appendFile, mkdir } from "node:fs/promises";
import { getMemoryLogPath, getMemoryLogsDir } from "./paths.js";

type MemoryLogLevel = "debug" | "info" | "warn" | "error";

let writeQueue: Promise<void> = Promise.resolve();

function formatLine(level: MemoryLogLevel, message: string, data?: Record<string, unknown>): string {
	const timestamp = new Date().toISOString();
	const payload = data ? ` ${safeJson(data)}` : "";
	return `${timestamp} [${level}] ${message}${payload}`;
}

function safeJson(data: Record<string, unknown>): string {
	try {
		return JSON.stringify(data);
	} catch {
		return "[unserializable]";
	}
}

async function appendLogLine(line: string): Promise<void> {
	await mkdir(getMemoryLogsDir(), { recursive: true });
	await appendFile(getMemoryLogPath(), `${line}\n`, { encoding: "utf-8" });
}

function enqueue(level: MemoryLogLevel, message: string, data?: Record<string, unknown>): void {
	const line = formatLine(level, message, data);
	writeQueue = writeQueue.then(() => appendLogLine(line)).catch(() => {});
}

export const memoryLog = {
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