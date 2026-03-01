import { loadSessionTranscriptState } from "./transcript/state.js";
import { readSessionTranscriptDelta } from "./transcript/reader.js";
import { getSessionTranscriptStatePath, normalizeSessionId } from "./transcript/paths.js";

export interface SessionFlushPolicy {
	deltaBytes: number;
	deltaMessages: number;
}

export interface SessionFlushDelta {
	sessionId: string;
	lastLine: number;
	deltaBytes: number;
	deltaMessages: number;
	shouldFlush: boolean;
}

function normalizeThreshold(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.trunc(value));
}

function hasDeltaThresholds(policy: SessionFlushPolicy): boolean {
	return normalizeThreshold(policy.deltaBytes) > 0 || normalizeThreshold(policy.deltaMessages) > 0;
}

export async function evaluateSessionFlushDelta(params: {
	agentId: string;
	sessionFile: string;
	policy: SessionFlushPolicy;
}): Promise<SessionFlushDelta> {
	const byteThreshold = normalizeThreshold(params.policy.deltaBytes);
	const messageThreshold = normalizeThreshold(params.policy.deltaMessages);

	const initialSessionId = normalizeSessionId(undefined, params.sessionFile);
	const initialStatePath = getSessionTranscriptStatePath(params.agentId, initialSessionId);
	const initialState = await loadSessionTranscriptState(initialStatePath);

	const delta = await readSessionTranscriptDelta(params.sessionFile, initialState.lastLine);
	const finalSessionId = normalizeSessionId(delta.sessionId, params.sessionFile);
	const statePath = getSessionTranscriptStatePath(params.agentId, finalSessionId);
	const state = finalSessionId === initialSessionId ? initialState : await loadSessionTranscriptState(statePath);
	const finalDelta =
		finalSessionId === initialSessionId
			? delta
			: await readSessionTranscriptDelta(params.sessionFile, state.lastLine);

	const bytesReached = byteThreshold > 0 && finalDelta.deltaBytes >= byteThreshold;
	const messagesReached = messageThreshold > 0 && finalDelta.messages.length >= messageThreshold;

	return {
		sessionId: finalSessionId,
		lastLine: finalDelta.lastLine,
		deltaBytes: finalDelta.deltaBytes,
		deltaMessages: finalDelta.messages.length,
		shouldFlush: hasDeltaThresholds(params.policy) && (bytesReached || messagesReached),
	};
}
