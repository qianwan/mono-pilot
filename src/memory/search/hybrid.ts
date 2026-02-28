import type { FtsSearchResult } from "./fts.js";
import type { VectorSearchResult } from "./vector.js";

export interface HybridSearchResult {
	path: string;
	startLine: number;
	endLine: number;
	score: number;
	snippet: string;
	agentId?: string;
}

export function mergeHybridResults(params: {
	vector: VectorSearchResult[];
	keyword: FtsSearchResult[];
	vectorWeight: number;
	textWeight: number;
}): HybridSearchResult[] {
	const byId = new Map<
		string,
		{
			path: string;
			startLine: number;
			endLine: number;
			snippet: string;
			vectorScore: number;
			textScore: number;
			agentId?: string;
		}
	>();

	for (const entry of params.vector) {
		byId.set(entry.id, {
			path: entry.path,
			startLine: entry.startLine,
			endLine: entry.endLine,
			snippet: entry.snippet,
			vectorScore: entry.vectorScore,
			textScore: 0,
			agentId: entry.agentId,
		});
	}

	for (const entry of params.keyword) {
		const existing = byId.get(entry.id);
		if (existing) {
			existing.textScore = Math.max(existing.textScore, entry.textScore);
			if (!existing.snippet && entry.snippet) {
				existing.snippet = entry.snippet;
			}
			if (!existing.agentId && entry.agentId) {
				existing.agentId = entry.agentId;
			}
		} else {
			byId.set(entry.id, {
				path: entry.path,
				startLine: entry.startLine,
				endLine: entry.endLine,
				snippet: entry.snippet,
				vectorScore: 0,
				textScore: entry.textScore,
				agentId: entry.agentId,
			});
		}
	}

	const vectorWeight = params.vectorWeight;
	const textWeight = params.textWeight;
	return Array.from(byId.values()).map((entry) => ({
		path: entry.path,
		startLine: entry.startLine,
		endLine: entry.endLine,
		snippet: entry.snippet,
		score: entry.vectorScore * vectorWeight + entry.textScore * textWeight,
		agentId: entry.agentId,
	}));
}