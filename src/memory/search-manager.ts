import { loadResolvedMemorySearchConfig } from "./config/loader.js";
import { WorkerMemoryProxy } from "./worker/proxy.js";

const managerCache = new Map<string, WorkerMemoryProxy>();

export async function getMemorySearchManager(params: {
	workspaceDir: string;
	agentId: string;
}): Promise<WorkerMemoryProxy | null> {
	const settings = await loadResolvedMemorySearchConfig();
	if (!settings.enabled) return null;
	if (!settings.sources.includes("memory")) return null;

	const key = settings.scope === "all" ? "all" : params.agentId;
	const cached = managerCache.get(key);
	if (cached) return cached;

	const manager = new WorkerMemoryProxy({
		agentId: params.agentId,
		workspaceDir: params.workspaceDir,
		settings,
	});
	managerCache.set(key, manager);
	return manager;
}

export async function closeMemorySearchManagers(): Promise<void> {
	const managers = Array.from(managerCache.values());
	managerCache.clear();
	for (const manager of managers) {
		if (manager.close) {
			await manager.close();
		}
	}
}

export function peekMemorySearchManager(params: {
	agentId: string;
	scope: "agent" | "all";
}): WorkerMemoryProxy | null {
	const key = params.scope === "all" ? "all" : params.agentId;
	return managerCache.get(key) ?? null;
}