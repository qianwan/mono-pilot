import { readFile } from "node:fs/promises";
import type { ResolvedMemorySearchConfig } from "../config/types.js";
import type { MemorySearchManager, MemorySearchQueryOptions, MemorySearchResult } from "../types.js";
import { listAgentIds } from "../agents/paths.js";
import { MemoryIndexManager } from "./index-manager.js";

export class MultiAgentMemorySearchManager implements MemorySearchManager {
	private readonly workspaceDir: string;
	private readonly settings: ResolvedMemorySearchConfig;
	private readonly managers = new Map<string, MemoryIndexManager>();

	constructor(params: { workspaceDir: string; settings: ResolvedMemorySearchConfig }) {
		this.workspaceDir = params.workspaceDir;
		this.settings = params.settings;
	}

	async search(query: string, opts?: MemorySearchQueryOptions): Promise<MemorySearchResult[]> {
		const agentIds = await listAgentIds();
		const results: MemorySearchResult[] = [];
		for (const agentId of agentIds) {
			const manager = this.getOrCreateManager(agentId);
			const agentResults = await manager.search(query, opts);
			for (const entry of agentResults) {
				results.push({ ...entry, agentId });
			}
		}
		const minScore = opts?.minScore ?? this.settings.query.minScore;
		const maxResults = opts?.maxResults ?? this.settings.query.maxResults;
		return results
			.filter((entry) => entry.score >= minScore)
			.sort((a, b) => b.score - a.score)
			.slice(0, maxResults);
	}

	async get(path: string, from?: number, lines?: number): Promise<{ path: string; text: string }> {
		const raw = await readFile(path, "utf-8");
		if (from === undefined && lines === undefined) {
			return { path, text: raw };
		}
		const startLine = Math.max(1, Math.floor(from ?? 1));
		const maxLines = lines !== undefined ? Math.max(0, Math.floor(lines)) : undefined;
		const allLines = raw.split("\n");
		const startIndex = Math.min(allLines.length, Math.max(0, startLine - 1));
		const endIndex =
			maxLines === undefined ? allLines.length : Math.min(allLines.length, startIndex + maxLines);
		return { path, text: allLines.slice(startIndex, endIndex).join("\n") };
	}

	async sync(): Promise<void> {
		const agentIds = await listAgentIds();
		for (const agentId of agentIds) {
			const manager = this.getOrCreateManager(agentId);
			await manager.sync({ reason: "multi-agent" });
		}
	}

	async close(): Promise<void> {
		const managers = Array.from(this.managers.values());
		this.managers.clear();
		for (const manager of managers) {
			await manager.close();
		}
	}

	private getOrCreateManager(agentId: string): MemoryIndexManager {
		const cached = this.managers.get(agentId);
		if (cached) return cached;
		const manager = new MemoryIndexManager({
			agentId,
			workspaceDir: this.workspaceDir,
			settings: this.settings,
		});
		this.managers.set(agentId, manager);
		return manager;
	}
}