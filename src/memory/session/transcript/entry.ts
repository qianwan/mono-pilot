import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionTranscriptMessage } from "./reader.js";

export interface SessionTranscriptEntryInput {
	timestamp: Date;
	reason: "new" | "resume" | "compaction";
	sessionId?: string;
	sessionFile: string;
	fromLineExclusive: number;
	toLineInclusive: number;
	messages: SessionTranscriptMessage[];
}

function formatMessages(messages: SessionTranscriptMessage[]): string {
	return messages.map((message) => `${message.role}: ${message.text}`).join("\n");
}

export function buildSessionTranscriptEntry(input: SessionTranscriptEntryInput): string {
	const iso = input.timestamp.toISOString();
	const [datePart, timePart] = iso.split("T");
	const time = (timePart ?? "").split(".")[0] ?? "";

	const lines: string[] = [
		`# Session Transcript Delta: ${datePart ?? ""} ${time} UTC`,
		"",
		`- **Reason**: ${input.reason}`,
		`- **Session ID**: ${input.sessionId ?? "unknown"}`,
		`- **Session File**: ${input.sessionFile}`,
		`- **Range**: lines ${input.fromLineExclusive + 1}-${input.toLineInclusive}`,
		"",
		"## Conversation Excerpt",
		"",
		formatMessages(input.messages),
		"",
	];

	return lines.join("\n");
}

export async function writeSessionTranscriptFile(filePath: string, content: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, content, "utf-8");
}
