import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Derive a stable, traceable agent ID from a project path.
 * Uses the same convention as pi-coding-agent session directories:
 * `/Users/wanqian/foo` → `--Users-wanqian-foo--`
 */
export function deriveAgentId(cwd: string): string {
	return `-${resolve(cwd).replaceAll("/", "-")}--`;
}

export function getAllAgentsDir(): string {
	return join(homedir(), ".mono-pilot", "agents");
}

export function getAgentDir(agentId: string): string {
	return join(getAllAgentsDir(), agentId);
}

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