import { loadResolvedMemorySearchConfig } from "./config/loader.js";
import { getMemorySearchManager } from "./search-manager.js";

export async function warmMemorySearch(params: {
	workspaceDir: string;
	agentId: string;
}): Promise<void> {
	try {
		const settings = await loadResolvedMemorySearchConfig();
		if (!settings.enabled || !settings.sync.onSessionStart) return;
		const manager = await getMemorySearchManager(params);
		if (!manager?.sync) return;
		await manager.sync({ reason: "session-start" });
	} catch (err) {
		console.warn(`[memory] warm failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}