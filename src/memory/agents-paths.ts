import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, getAllAgentsDir } from "../brief/paths.js";

export function getAgentMemoryDir(agentId: string): string {
	return join(getAgentDir(agentId), "memory");
}

export async function listAgentIds(): Promise<string[]> {
	const baseDir = getAllAgentsDir();
	try {
		const entries = await readdir(baseDir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}