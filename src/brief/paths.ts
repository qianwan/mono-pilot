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

export function getAgentDir(agentId: string): string {
	return join(homedir(), ".mono-pilot", "agents", agentId);
}

export function getAgentBriefDir(agentId: string): string {
	return join(getAgentDir(agentId), "brief");
}

export function getAllAgentsDir(): string {
	return join(homedir(), ".mono-pilot", "agents");
}

export function resolveBriefPath(relativePath: string, agentId: string): string {
	return join(getAgentBriefDir(agentId), relativePath);
}