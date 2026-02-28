import { unlink } from "node:fs/promises";
import { loadResolvedMemorySearchConfig } from "./config/loader.js";
import { closeMemorySearchManagers, peekMemorySearchManager } from "./search-manager.js";
import { getAgentMemoryIndexPath, listAgentIds } from "./agents-paths.js";
import { MemoryIndexManager } from "./manager/index-manager.js";
import { deriveAgentId } from "../brief/paths.js";

export type BuildMode = "full" | "dirty";
export type BuildScope = "current" | "all";

export interface BuildMemoryParams {
	workspaceDir: string;
	mode: BuildMode;
	scope: BuildScope;
}

export interface BuildMemoryResult {
	ok: boolean;
	message: string;
	agents: string[];
}

export async function buildMemoryIndex(params: BuildMemoryParams): Promise<BuildMemoryResult> {
	const settings = await loadResolvedMemorySearchConfig();
	if (!settings.enabled) {
		return { ok: false, message: "Memory search is disabled in config.", agents: [] };
	}
	if (!settings.sources.includes("memory")) {
		return { ok: false, message: "Config sources do not include 'memory'.", agents: [] };
	}

	if (params.mode === "dirty" && params.scope === "all") {
		return {
			ok: false,
			message: "dirty + scope all is not supported: runtime dirty state is per-process only. Use --mode full --scope all instead.",
			agents: [],
		};
	}

	if (params.mode === "full") {
		return await buildFull(params, settings);
	}
	return await buildDirty(params);
}

async function buildFull(
	params: BuildMemoryParams,
	settings: Awaited<ReturnType<typeof loadResolvedMemorySearchConfig>>,
): Promise<BuildMemoryResult> {
	// Release cached managers so DB files are not locked
	await closeMemorySearchManagers();

	const agentIds =
		params.scope === "all"
			? await listAgentIds()
			: [deriveAgentId(params.workspaceDir)];

	if (agentIds.length === 0) {
		return { ok: true, message: "No agents found.", agents: [] };
	}

	for (const agentId of agentIds) {
		const indexPath = getAgentMemoryIndexPath(agentId);
		try {
			await unlink(indexPath);
		} catch {
			// Index file may not exist yet
		}

		const manager = new MemoryIndexManager({
			agentId,
			workspaceDir: params.workspaceDir,
			settings,
		});
		try {
			await manager.sync({ reason: "build-full", force: true });
		} finally {
			await manager.close();
		}
	}

	return {
		ok: true,
		message: `Full rebuild completed for ${agentIds.length} agent(s).`,
		agents: agentIds,
	};
}

async function buildDirty(params: BuildMemoryParams): Promise<BuildMemoryResult> {
	const agentId = deriveAgentId(params.workspaceDir);
	const manager = peekMemorySearchManager({
		agentId,
		scope: "agent",
	});

	if (!manager) {
		return { ok: true, message: "No active memory manager found. Nothing to sync.", agents: [] };
	}

	if (!manager.isDirty?.()) {
		return { ok: true, message: "Memory index is up to date (not dirty).", agents: [] };
	}

	if (manager.syncDirty) {
		const synced = await manager.syncDirty();
		return {
			ok: true,
			message: synced.length > 0
				? `Dirty sync completed for ${synced.length} agent(s).`
				: "No dirty agents found.",
			agents: synced,
		};
	}

	if (manager.sync) {
		await manager.sync({ reason: "build-dirty" });
	}
	return {
		ok: true,
		message: "Dirty sync completed.",
		agents: [agentId],
	};
}