import { join } from "node:path";
import { getAgentDir } from "../agents-paths.js";

// Re-export agent-level paths for backward compatibility during migration
export { deriveAgentId, getAgentDir, getAllAgentsDir } from "../agents-paths.js";

export function getAgentBriefDir(agentId: string): string {
	return join(getAgentDir(agentId), "brief");
}

export function resolveBriefPath(relativePath: string, agentId: string): string {
	return join(getAgentBriefDir(agentId), relativePath);
}