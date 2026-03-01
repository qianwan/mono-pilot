import { join } from "node:path";
import { buildTranscriptContentHashSlug } from "./content-hash.js";
import { formatSessionTimestampParts } from "../paths.js";
import { buildSessionTranscriptEntry, writeSessionTranscriptFile } from "./entry.js";
import { readSessionTranscriptDelta } from "./reader.js";
import {
	buildSessionTranscriptFilename,
	getSessionTranscriptDir,
	getSessionTranscriptStatePath,
	normalizeSessionId,
} from "./paths.js";
import { loadSessionTranscriptState, saveSessionTranscriptState } from "./state.js";

export interface SessionTranscriptFlushParams {
	agentId: string;
	reason: "new" | "resume" | "compaction";
	sessionFile: string;
}

export interface SessionTranscriptFlushResult {
	written: boolean;
	filePath?: string;
	lastLine: number;
}

function toIsoMinuteSlug(time: string): string {
	return time.replace(/:/g, "").slice(0, 4);
}

export async function flushSessionTranscript(
	params: SessionTranscriptFlushParams,
): Promise<SessionTranscriptFlushResult> {
	const initialSessionId = normalizeSessionId(undefined, params.sessionFile);
	const initialStatePath = getSessionTranscriptStatePath(params.agentId, initialSessionId);
	const initialState = await loadSessionTranscriptState(initialStatePath);

	const delta = await readSessionTranscriptDelta(params.sessionFile, initialState.lastLine);
	const finalSessionId = normalizeSessionId(delta.sessionId, params.sessionFile);
	const statePath = getSessionTranscriptStatePath(params.agentId, finalSessionId);
	const state = finalSessionId === initialSessionId ? initialState : await loadSessionTranscriptState(statePath);
	const finalDelta = finalSessionId === initialSessionId
		? delta
		: await readSessionTranscriptDelta(params.sessionFile, state.lastLine);

	if (finalDelta.messages.length === 0) {
		await saveSessionTranscriptState(statePath, {
			lastLine: finalDelta.lastLine,
			updatedAt: new Date().toISOString(),
		});
		return { written: false, lastLine: finalDelta.lastLine };
	}

	const now = new Date();
	const { date, time } = formatSessionTimestampParts(now);
	const timeSlug = toIsoMinuteSlug(time);
	const textForHash = finalDelta.messages.map((msg) => `${msg.role}:${msg.text}`).join("\n");
	const hashSlug = buildTranscriptContentHashSlug(`${finalDelta.sessionId ?? finalSessionId}\n${textForHash}`);
	const filename = buildSessionTranscriptFilename(date, timeSlug, hashSlug);
	const transcriptDir = getSessionTranscriptDir(params.agentId, finalSessionId);
	const transcriptPath = join(transcriptDir, filename);

	const content = buildSessionTranscriptEntry({
		timestamp: now,
		reason: params.reason,
		sessionId: finalDelta.sessionId,
		sessionFile: params.sessionFile,
		fromLineExclusive: state.lastLine,
		toLineInclusive: finalDelta.lastLine,
		messages: finalDelta.messages,
	});

	await writeSessionTranscriptFile(transcriptPath, content);
	await saveSessionTranscriptState(statePath, {
		lastLine: finalDelta.lastLine,
		updatedAt: now.toISOString(),
	});

	return {
		written: true,
		filePath: transcriptPath,
		lastLine: finalDelta.lastLine,
	};
}
