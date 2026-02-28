import { loadResolvedMemorySearchConfig } from "./config/loader.js";
import { closeMemorySearchManagers, peekMemorySearchManager } from "./search-manager.js";
import { getMemoryIndexPath } from "./paths.js";
import { MemoryIndexManager } from "./manager/index-manager.js";
import { deriveAgentId } from "../brief/paths.js";
import { openSqliteDatabase } from "./store/sqlite.js";
import { ensureMemoryIndexSchema, CHUNKS_TABLE, FILES_TABLE, FTS_TABLE, VECTOR_TABLE } from "./store/schema.js";
import { memoryLog } from "./log.js";

export type BuildMode = "full" | "dirty";

export interface BuildMemoryParams {
	workspaceDir: string;
	mode: BuildMode;
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

	const agentId = deriveAgentId(params.workspaceDir);
	memoryLog.info("build full start", { agentId });
	await clearAgentPartition(agentId, settings);

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
	memoryLog.info("build full complete", { agentId });

	return {
		ok: true,
		message: `Full rebuild completed for agent ${agentId}.`,
		agents: [agentId],
	};
}

async function buildDirty(params: BuildMemoryParams): Promise<BuildMemoryResult> {
	const agentId = deriveAgentId(params.workspaceDir);
	const manager = peekMemorySearchManager({ agentId });
	memoryLog.info("build dirty start", { agentId });

	if (!manager) {
		memoryLog.info("build dirty skipped", { agentId, reason: "no manager" });
		return { ok: true, message: "No active memory manager found. Nothing to sync.", agents: [] };
	}

	if (!manager.isDirty?.()) {
		memoryLog.info("build dirty skipped", { agentId, reason: "not dirty" });
		return { ok: true, message: "Memory index is up to date (not dirty).", agents: [] };
	}

	if (manager.syncDirty) {
		const synced = await manager.syncDirty();
		memoryLog.info("build dirty complete", { agentId, syncedCount: synced.length });
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
	memoryLog.info("build dirty complete", { agentId });
	return {
		ok: true,
		message: "Dirty sync completed.",
		agents: [agentId],
	};
}

async function clearAgentPartition(
	agentId: string,
	settings: Awaited<ReturnType<typeof loadResolvedMemorySearchConfig>>,
): Promise<void> {
	const indexPath = getMemoryIndexPath();
	const db = openSqliteDatabase(indexPath, true);
	try {
		ensureMemoryIndexSchema({ db, ftsEnabled: true });
		if (settings.store.vector.enabled) {
			try {
				db.prepare(
					`DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM ${CHUNKS_TABLE} WHERE agent_id = ?)`,
				).run(agentId);
			} catch {}
		}
		try {
			db.prepare(
				`DELETE FROM ${FTS_TABLE} WHERE id IN (SELECT id FROM ${CHUNKS_TABLE} WHERE agent_id = ?)`,
			).run(agentId);
		} catch {}
		db.prepare(`DELETE FROM ${CHUNKS_TABLE} WHERE agent_id = ?`).run(agentId);
		db.prepare(`DELETE FROM ${FILES_TABLE} WHERE agent_id = ?`).run(agentId);
	} finally {
		db.close();
	}
}