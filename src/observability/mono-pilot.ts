import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MonoPilotObservabilityConfig } from "../config/observability.js";

interface MonoPilotObservabilityContext {
	agentId?: string;
	sessionId?: string;
	scope?: string;
}

const LOGS_DIR = join(homedir(), ".mono-pilot", "logs");

const DEFAULT_CONFIG: MonoPilotObservabilityConfig = {
	enabled: true,
	file: {
		enabled: true,
		flushIntervalMs: 1000,
	},
};

let runtimeConfig: MonoPilotObservabilityConfig = DEFAULT_CONFIG;

let writeQueue: Promise<void> = Promise.resolve();
let pendingLines: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function getLogPath(date = new Date()): string {
	const stamp = date.toISOString().slice(0, 10);
	return join(LOGS_DIR, `observability.${stamp}.jsonl`);
}

function safeJson(data: Record<string, unknown>): string {
	try {
		return JSON.stringify(data);
	} catch {
		return JSON.stringify({
			timestamp: new Date().toISOString(),
			event: "serialization_error",
			pid: process.pid,
		});
	}
}

function scheduleFlush(): void {
	if (flushTimer || pendingLines.length === 0) {
		return;
	}

	const delay = runtimeConfig.file.flushIntervalMs;
	if (delay <= 0) {
		flushPendingLines();
		return;
	}

	flushTimer = setTimeout(() => {
		flushTimer = null;
		flushPendingLines();
	}, delay);
	flushTimer.unref?.();
}

function flushPendingLines(): void {
	if (pendingLines.length === 0) {
		return;
	}

	const chunk = `${pendingLines.join("\n")}\n`;
	pendingLines = [];

	writeQueue = writeQueue
		.then(async () => {
			await mkdir(LOGS_DIR, { recursive: true });
			await appendFile(getLogPath(), chunk, { encoding: "utf-8" });
		})
		.catch(() => {
			// Keep observability logging failures non-fatal.
		});
}

export function setMonoPilotObservabilityConfig(config: MonoPilotObservabilityConfig): void {
	runtimeConfig = {
		enabled: config.enabled,
		file: {
			enabled: config.file.enabled,
			flushIntervalMs: Math.max(0, Math.floor(config.file.flushIntervalMs)),
		},
	};

	if (!runtimeConfig.enabled || !runtimeConfig.file.enabled) {
		pendingLines = [];
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
		return;
	}

	scheduleFlush();
}

export function logMonoPilotObservabilityEvent(
	event: string,
	details?: Record<string, unknown>,
	context?: MonoPilotObservabilityContext,
): void {
	if (!runtimeConfig.enabled || !runtimeConfig.file.enabled) {
		return;
	}

	const record = {
		timestamp: new Date().toISOString(),
		event,
		pid: process.pid,
		agentId: context?.agentId ?? null,
		sessionId: context?.sessionId ?? null,
		scope: context?.scope ?? null,
		...(details ?? {}),
	};
	const line = safeJson(record);
	pendingLines.push(line);
	scheduleFlush();
}
