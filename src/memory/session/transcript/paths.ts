import { basename, extname, join } from "node:path";
import { getAgentDir } from "../../../brief/paths.js";

const MAX_SESSION_SLUG_CHARS = 80;

function sanitizeSessionId(raw: string): string {
	const normalized = raw
		.trim()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized.slice(0, MAX_SESSION_SLUG_CHARS);
}

export function normalizeSessionId(sessionId: string | undefined, sessionFile: string): string {
	const fallback = basename(sessionFile, extname(sessionFile));
	const candidate = sessionId && sessionId.trim().length > 0 ? sessionId : fallback;
	const sanitized = sanitizeSessionId(candidate);
	return sanitized || "unknown-session";
}

export function getSessionTranscriptsRootDir(agentId: string): string {
	return join(getAgentDir(agentId), "session-transcripts");
}

export function getSessionTranscriptDir(agentId: string, sessionSlug: string): string {
	return join(getSessionTranscriptsRootDir(agentId), sessionSlug);
}

export function getSessionTranscriptStatePath(agentId: string, sessionSlug: string): string {
	return join(getSessionTranscriptsRootDir(agentId), ".state", `${sessionSlug}.json`);
}

export function buildSessionTranscriptFilename(
	datePart: string,
	timePart: string,
	hashSlug: string,
): string {
	return `${datePart}-${timePart}-${hashSlug}.md`;
}
