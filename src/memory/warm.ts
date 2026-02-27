import { loadResolvedMemorySearchConfig } from "./config/loader.js";
import { getMemorySearchManager } from "./search-manager.js";

export async function warmMemorySearch(params: {
	workspaceDir: string;
	agentId: string;
}): Promise<void> {
	const settings = await loadResolvedMemorySearchConfig();
	if (!settings.enabled || !settings.sync.onSessionStart) return;
	const manager = await getMemorySearchManager(params);
	if (!manager?.sync) return;
	await manager.sync({ reason: "session-start" });
}