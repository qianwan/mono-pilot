import { join } from "node:path";
import { getAgentDir } from "../brief/paths.js";

export interface SessionTimestampParts {
	date: string;
	time: string;
	timeSlug: string;
}

export function getAgentMemoryDir(agentId: string): string {
	return join(getAgentDir(agentId), "memory");
}

export function formatSessionTimestampParts(timestamp: Date): SessionTimestampParts {
	const iso = timestamp.toISOString();
	const [datePart, timePart] = iso.split("T");
	const time = (timePart ?? "").split(".")[0] ?? "";
	const timeSlug = time.replace(/:/g, "").slice(0, 4);
	return { date: datePart ?? "", time, timeSlug };
}

export function buildMemoryFilename(date: string, slug: string): string {
	return `${date}-${slug}.md`;
}