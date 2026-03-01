import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SessionTranscriptState {
	lastLine: number;
	updatedAt: string;
}

const INITIAL_STATE: SessionTranscriptState = {
	lastLine: 0,
	updatedAt: new Date(0).toISOString(),
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export async function loadSessionTranscriptState(statePath: string): Promise<SessionTranscriptState> {
	try {
		const raw = await readFile(statePath, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed)) return INITIAL_STATE;
		const lastLineRaw = parsed.lastLine;
		const updatedAtRaw = parsed.updatedAt;
		const lastLine =
			typeof lastLineRaw === "number" && Number.isFinite(lastLineRaw) && lastLineRaw > 0
				? Math.trunc(lastLineRaw)
				: 0;
		const updatedAt = typeof updatedAtRaw === "string" && updatedAtRaw.trim() ? updatedAtRaw : INITIAL_STATE.updatedAt;
		return { lastLine, updatedAt };
	} catch {
		return INITIAL_STATE;
	}
}

export async function saveSessionTranscriptState(
	statePath: string,
	state: SessionTranscriptState,
): Promise<void> {
	await mkdir(dirname(statePath), { recursive: true });
	await writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");
}
