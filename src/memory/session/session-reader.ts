import { readFile } from "node:fs/promises";

export interface SessionMessageExcerpt {
	role: "user" | "assistant";
	text: string;
}

export interface SessionExcerptResult {
	sessionId?: string;
	messages: SessionMessageExcerpt[];
}

interface SessionMessageEntry {
	role?: string;
	content?: unknown;
}

interface SessionEntryRecord {
	type?: string;
	id?: string;
	message?: SessionMessageEntry;
}

function parseJsonLine(line: string): SessionEntryRecord | undefined {
	try {
		const parsed = JSON.parse(line) as SessionEntryRecord | undefined;
		return parsed && typeof parsed === "object" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function extractTextContent(content: unknown): string | undefined {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return undefined;
	}
	const texts = content
		.map((item) => {
			if (!item || typeof item !== "object") return undefined;
			const entry = item as { type?: string; text?: string };
			return entry.type === "text" && typeof entry.text === "string" ? entry.text : undefined;
		})
		.filter((text): text is string => typeof text === "string" && text.trim().length > 0);
	if (texts.length === 0) return undefined;
	return texts.join("\n");
}

function shouldSkipUserText(text: string): boolean {
	return text.trim().startsWith("/");
}

const USER_QUERY_OPEN = "<user_query>";
const USER_QUERY_CLOSE = "</user_query>";

function extractUserQuery(text: string): string | undefined {
	const start = text.indexOf(USER_QUERY_OPEN);
	const end = text.lastIndexOf(USER_QUERY_CLOSE);
	if (start === -1 || end === -1 || end <= start) return undefined;
	const extracted = text.slice(start + USER_QUERY_OPEN.length, end).trim();
	return extracted.length > 0 ? extracted : undefined;
}

export async function readSessionExcerpt(
	sessionFile: string,
	maxMessages: number,
): Promise<SessionExcerptResult> {
	const result: SessionExcerptResult = { messages: [] };
	if (maxMessages <= 0) return result;

	let raw: string;
	try {
		raw = await readFile(sessionFile, "utf-8");
	} catch {
		return result;
	}

	const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
	for (const line of lines) {
		const entry = parseJsonLine(line);
		if (!entry) continue;

		if (entry.type === "session" && typeof entry.id === "string" && !result.sessionId) {
			result.sessionId = entry.id;
			continue;
		}

		if (entry.type !== "message" || !entry.message) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = extractTextContent(entry.message.content ?? "");
		if (!text) continue;
		let normalized = text.trim();
		if (!normalized) continue;
		if (role === "user") {
			const extracted = extractUserQuery(normalized);
			if (!extracted) continue;
			if (shouldSkipUserText(extracted)) continue;
			normalized = extracted;
		}

		result.messages.push({ role, text: normalized });
		if (result.messages.length > maxMessages) {
			result.messages.shift();
		}
	}

	return result;
}