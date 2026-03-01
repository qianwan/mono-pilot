import { readFile } from "node:fs/promises";

export interface SessionTranscriptMessage {
	role: "user" | "assistant";
	text: string;
	line: number;
}

export interface SessionTranscriptDelta {
	sessionId?: string;
	messages: SessionTranscriptMessage[];
	lastLine: number;
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

const USER_QUERY_OPEN = "<user_query>";
const USER_QUERY_CLOSE = "</user_query>";

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

function extractUserQuery(text: string): string | undefined {
	const start = text.indexOf(USER_QUERY_OPEN);
	const end = text.lastIndexOf(USER_QUERY_CLOSE);
	if (start === -1 || end === -1 || end <= start) return undefined;
	const extracted = text.slice(start + USER_QUERY_OPEN.length, end).trim();
	return extracted.length > 0 ? extracted : undefined;
}

export async function readSessionTranscriptDelta(
	sessionFile: string,
	fromLineExclusive: number,
): Promise<SessionTranscriptDelta> {
	const result: SessionTranscriptDelta = {
		messages: [],
		lastLine: fromLineExclusive,
	};

	let raw: string;
	try {
		raw = await readFile(sessionFile, "utf-8");
	} catch {
		return result;
	}

	const lines = raw.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const lineNo = index + 1;
		const line = lines[index] ?? "";
		if (!line.trim()) continue;
		if (lineNo <= fromLineExclusive) {
			result.lastLine = lineNo;
			continue;
		}

		const entry = parseJsonLine(line);
		if (!entry) {
			result.lastLine = lineNo;
			continue;
		}

		if (entry.type === "session" && typeof entry.id === "string" && !result.sessionId) {
			result.sessionId = entry.id;
			result.lastLine = lineNo;
			continue;
		}

		if (entry.type !== "message" || !entry.message) {
			result.lastLine = lineNo;
			continue;
		}

		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") {
			result.lastLine = lineNo;
			continue;
		}

		const text = extractTextContent(entry.message.content ?? "");
		if (!text) {
			result.lastLine = lineNo;
			continue;
		}

		let normalized = text.trim();
		if (!normalized) {
			result.lastLine = lineNo;
			continue;
		}

		if (role === "user") {
			const extracted = extractUserQuery(normalized);
			if (!extracted) {
				result.lastLine = lineNo;
				continue;
			}
			if (shouldSkipUserText(extracted)) {
				result.lastLine = lineNo;
				continue;
			}
			normalized = extracted;
		}

		result.messages.push({ role, text: normalized, line: lineNo });
		result.lastLine = lineNo;
	}

	return result;
}
