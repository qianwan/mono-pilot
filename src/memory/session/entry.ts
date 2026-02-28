import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { SessionMessageExcerpt } from "./session-reader.js";

export interface SessionMemoryEntryInput {
	timestamp: Date;
	reason: "new" | "resume" | "compaction";
	sessionId?: string;
	sessionFile?: string;
	messages: SessionMessageExcerpt[];
}

function shortenHomePath(pathValue: string): string {
	const home = homedir();
	return pathValue.startsWith(home) ? `~${pathValue.slice(home.length)}` : pathValue;
}

function formatExcerpt(messages: SessionMessageExcerpt[]): string {
	return messages.map((message) => `${message.role}: ${message.text}`).join("\n");
}

export function buildSessionMemoryEntry(input: SessionMemoryEntryInput): string {
	const iso = input.timestamp.toISOString();
	const [datePart, timePart] = iso.split("T");
	const time = (timePart ?? "").split(".")[0] ?? "";
	const lines: string[] = [
		`# Session: ${datePart ?? ""} ${time} UTC`,
		"",
		`- **Reason**: ${input.reason}`,
		`- **Session ID**: ${input.sessionId ?? "unknown"}`,
	];

	if (input.sessionFile) {
		lines.push(`- **Session File**: ${shortenHomePath(input.sessionFile)}`);
	}

	lines.push("");

	if (input.messages.length > 0) {
		lines.push("## Conversation Excerpt", "", formatExcerpt(input.messages), "");
	}

	return lines.join("\n");
}

export async function writeSessionMemoryFile(filePath: string, content: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, content, "utf-8");
}