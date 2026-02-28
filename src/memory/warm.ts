import { loadResolvedMemorySearchConfig } from "./config/loader.js";
import { getMemorySearchManager } from "./search-manager.js";
import { memoryLog } from "./log.js";

export async function warmMemorySearch(params: {
	workspaceDir: string;
	agentId: string;
}): Promise<void> {
	try {
		const settings = await loadResolvedMemorySearchConfig();
		if (!settings.enabled || !settings.sync.onSessionStart) return;
		memoryLog.info("warm start", { agentId: params.agentId });
		const manager = await getMemorySearchManager(params);
		if (!manager?.sync) return;
		await manager.sync({ reason: "session-start" });
		memoryLog.info("warm complete", { agentId: params.agentId });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`[memory] warm failed: ${message}`);
		memoryLog.error("warm failed", { agentId: params.agentId, error: message });
	}
}