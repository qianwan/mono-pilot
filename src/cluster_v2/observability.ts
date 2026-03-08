import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type ClusterLogLevel = "info" | "warn" | "error";

export type RequestTerminalState = "ok" | "timeout" | "error" | "aborted" | "closed";

export interface ClusterLogContext {
	pid: number;
	agentId: string | null;
	sessionId: string | null;
	scope: string | null;
	role: string | null;
}

const LOGS_DIR = join(homedir(), ".mono-pilot", "logs");
const STDIO_ENV = "MONO_PILOT_CLUSTER_V2_LOG_STDIO";

let writeQueue: Promise<void> = Promise.resolve();

function getLogPath(date = new Date()): string {
	const stamp = date.toISOString().slice(0, 10);
	return join(LOGS_DIR, `cluster_v2.${stamp}.log`);
}

function shouldMirrorToStdout(): boolean {
	if (process.env.NODE_ENV === "test") {
		return true;
	}
	return process.env[STDIO_ENV] === "1";
}

function enqueueLogLine(line: string): void {
	writeQueue = writeQueue
		.then(async () => {
			await mkdir(LOGS_DIR, { recursive: true });
			await appendFile(getLogPath(), `${line}\n`, { encoding: "utf-8" });
		})
		.catch(() => {
			// Keep logging failures non-fatal.
		});
}

function mirrorToStdio(level: ClusterLogLevel, line: string): void {
	if (!shouldMirrorToStdout()) {
		return;
	}
	if (level === "error") {
		console.error(line);
		return;
	}
	if (level === "warn") {
		console.warn(line);
		return;
	}
	console.info(line);
}

export function createClusterLogContext(context?: {
	agentId?: string;
	sessionId?: string;
	scope?: string;
	role?: string;
}): ClusterLogContext {
	return {
		pid: process.pid,
		agentId: context?.agentId ?? null,
		sessionId: context?.sessionId ?? null,
		scope: context?.scope ?? null,
		role: context?.role ?? null,
	};
}

export function logClusterEvent(
	level: ClusterLogLevel,
	event: string,
	context: ClusterLogContext,
	details?: Record<string, unknown>,
): void {
	const record = {
		timestamp: new Date().toISOString(),
		event,
		...context,
		...(details ?? {}),
	};
	const line = `[cluster_v2] ${JSON.stringify(record)}`;
	enqueueLogLine(line);
	mirrorToStdio(level, line);
}

export class RequestCounters {
	private started = 0;
	private completed = 0;
	private byState: Record<RequestTerminalState, number> = {
		ok: 0,
		timeout: 0,
		error: 0,
		aborted: 0,
		closed: 0,
	};

	start(): void {
		this.started++;
	}

	complete(state: RequestTerminalState): void {
		this.completed++;
		this.byState[state]++;
	}

	outstanding(): number {
		return this.started - this.completed;
	}

	snapshot(): {
		started: number;
		completed: number;
		outstanding: number;
		byState: Record<RequestTerminalState, number>;
	} {
		return {
			started: this.started,
			completed: this.completed,
			outstanding: this.outstanding(),
			byState: { ...this.byState },
		};
	}

	assertConsistency(
		expectedOutstanding: number,
		context: ClusterLogContext,
		source: string,
	): void {
		const outstanding = this.outstanding();
		if (this.completed > this.started || outstanding !== expectedOutstanding) {
			logClusterEvent("warn", "request_counter_mismatch", context, {
				source,
				expectedOutstanding,
				...this.snapshot(),
			});
		}
	}
}
