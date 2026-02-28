import type { DatabaseSync } from "node:sqlite";
import { CHUNKS_TABLE, FTS_TABLE } from "../store/schema.js";
import { truncateUtf16Safe } from "./text.js";

export interface FtsSearchResult {
	id: string;
	path: string;
	startLine: number;
	endLine: number;
	score: number;
	textScore: number;
	snippet: string;
	agentId?: string;
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
	model?: string;
	agentId?: string;
}): FtsSearchResult[] {
	if (params.limit <= 0) return [];
	const ftsQuery = buildFtsQuery(params.query);
	if (!ftsQuery) return [];
	const modelClause = params.model ? ` AND ${FTS_TABLE}.model = ?` : "";
	const modelParams = params.model ? [params.model] : [];
	const agentJoin = ` JOIN ${CHUNKS_TABLE} c ON c.id = ${FTS_TABLE}.id`;
	const agentClause = params.agentId ? " AND c.agent_id = ?" : "";
	const agentParams = params.agentId ? [params.agentId] : [];
	const rows = params.db
		.prepare(
			`SELECT ${FTS_TABLE}.id as id, ${FTS_TABLE}.path as path,
				   ${FTS_TABLE}.start_line as start_line,
				   ${FTS_TABLE}.end_line as end_line,
				   ${FTS_TABLE}.text as text,
				   bm25(${FTS_TABLE}) AS rank, c.agent_id as agent_id
			 FROM ${FTS_TABLE}${agentJoin}
			 WHERE ${FTS_TABLE} MATCH ?${modelClause}${agentClause}
			 ORDER BY rank ASC
			 LIMIT ?`,
		)
		.all(ftsQuery, ...modelParams, ...agentParams, params.limit) as Array<{
			id: string;
			path: string;
			start_line: number;
			end_line: number;
			text: string;
			rank: number;
			agent_id?: string;
		}>;

	return rows
		.map((row) => {
			const textScore = bm25RankToScore(row.rank);
			return {
				id: row.id,
				path: row.path,
				startLine: row.start_line,
				endLine: row.end_line,
				score: textScore,
				textScore,
				snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
				agentId: row.agent_id,
			};
		})
		.filter((row) => row.score >= params.minScore);
}