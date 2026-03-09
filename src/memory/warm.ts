import { loadResolvedMemorySearchConfig } from "./config/loader.js";
import { getMemorySearchManager } from "./runtime/index.js";
import { memoryLog } from "./log.js";

export interface MemoryWarmupResult {
	attempted: boolean;
	succeeded: boolean;
	error?: string;
}

export async function warmMemorySearch(params: {
	workspaceDir: string;
	agentId: string;
	onWorkDetected?: () => void;
}): Promise<MemoryWarmupResult> {
	try {
		const settings = await loadResolvedMemorySearchConfig();
		if (!settings.enabled || !settings.sync.onSessionStart) {
			return { attempted: false, succeeded: true };
		}
		memoryLog.info("warm start", { agentId: params.agentId });
		const manager = await getMemorySearchManager(params);
		if (!manager?.sync) {
			return { attempted: false, succeeded: true };
		}
		await manager.sync({ reason: "session-start", onWorkDetected: params.onWorkDetected });
		memoryLog.info("warm complete", { agentId: params.agentId });
		return { attempted: true, succeeded: true };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`[memory] warm failed: ${message}`);
		memoryLog.error("warm failed", { agentId: params.agentId, error: message });
		return { attempted: true, succeeded: false, error: message };
	}
}