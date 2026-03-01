import { createHash } from "node:crypto";

const HASH_LENGTH = 12;

export function buildTranscriptContentHashSlug(content: string): string {
	const normalized = content.trim().replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const hash = createHash("sha256").update(normalized).digest("hex");
	return hash.slice(0, HASH_LENGTH);
}
