import type { DatabaseSync } from "node:sqlite";
import { FTS_TABLE } from "../store/tables.js";
import { truncateUtf16Safe } from "./text.js";

export interface FtsSearchResult {
	id: string;
	path: string;
	startLine: number;
	endLine: number;
	score: number;
	snippet: string;
}

export function buildFtsQuery(raw: string): string | null {
	const tokens =
		raw
			.match(/[\p{L}\p{N}_]+/gu)
			?.map((token) => token.trim())
			.filter(Boolean) ?? [];
	if (tokens.length === 0) return null;
	const quoted = tokens.map((token) => `"${token.replaceAll('"', "")}"`);
	return quoted.join(" AND ");
}

export function bm25RankToScore(rank: number): number {
	const normalized = Number.isFinite(rank) ? Math.max(0, rank) : 999;
	return 1 / (1 + normalized);
}

export function searchFts(params: {
	db: DatabaseSync;
	query: string;
	limit: number;
	minScore: number;
	snippetMaxChars: number;
}): FtsSearchResult[] {
	if (params.limit <= 0) return [];
	const ftsQuery = buildFtsQuery(params.query);
	if (!ftsQuery) return [];
	const rows = params.db
		.prepare(
			`SELECT id, path, start_line, end_line, text, bm25(${FTS_TABLE}) AS rank
			 FROM ${FTS_TABLE}
			 WHERE ${FTS_TABLE} MATCH ?
			 ORDER BY rank ASC
			 LIMIT ?`,
		)
		.all(ftsQuery, params.limit) as Array<{
			id: string;
			path: string;
			start_line: number;
			end_line: number;
			text: string;
			rank: number;
		}>;

	return rows
		.map((row) => {
			const score = bm25RankToScore(row.rank);
			return {
				id: row.id,
				path: row.path,
				startLine: row.start_line,
				endLine: row.end_line,
				score,
				snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
			};
		})
		.filter((row) => row.score >= params.minScore);
}