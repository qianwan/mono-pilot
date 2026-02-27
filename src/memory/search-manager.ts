import type { MemorySearchManager } from "./types.js";
import { loadResolvedMemorySearchConfig } from "./config/loader.js";
import { MemoryIndexManager } from "./manager/index-manager.js";
import { MultiAgentMemorySearchManager } from "./manager/multi-agent-manager.js";

const managerCache = new Map<string, MemorySearchManager>();

export async function getMemorySearchManager(params: {
	workspaceDir: string;
	agentId: string;
}): Promise<MemorySearchManager | null> {
	const settings = await loadResolvedMemorySearchConfig();
	if (!settings.enabled) return null;
	if (!settings.sources.includes("memory")) return null;

	const key = settings.scope === "all" ? "all" : params.agentId;
	const cached = managerCache.get(key);
	if (cached) return cached;

	const manager =
		settings.scope === "all"
			? new MultiAgentMemorySearchManager({
					workspaceDir: params.workspaceDir,
					settings,
				})
			: new MemoryIndexManager({
					agentId: params.agentId,
					workspaceDir: params.workspaceDir,
					settings,
				});
	managerCache.set(key, manager);
	return manager;
}