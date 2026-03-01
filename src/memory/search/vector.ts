import type { DatabaseSync } from "node:sqlite";
import { CHUNKS_TABLE, VECTOR_TABLE } from "../store/schema.js";
import { truncateUtf16Safe } from "./text.js";

const vectorToBlob = (embedding: number[]): Buffer => Buffer.from(new Float32Array(embedding).buffer);

export interface VectorSearchResult {
	id: string;
	path: string;
	startLine: number;
	endLine: number;
	vectorScore: number;
	snippet: string;
	source: "memory" | "sessions";
	agentId?: string;
}

export async function searchVector(params: {
	db: DatabaseSync;
	queryVec: number[];
	limit: number;
	snippetMaxChars: number;
	model?: string;
	agentId?: string;
	source?: "memory" | "sessions";
}): Promise<VectorSearchResult[]> {
	if (params.queryVec.length === 0 || params.limit <= 0) {
		return [];
	}
	const conditions: string[] = [];
	const paramsList: Array<string> = [];
	if (params.model) {
		conditions.push("c.model = ?");
		paramsList.push(params.model);
	}
	if (params.agentId) {
		conditions.push("c.agent_id = ?");
		paramsList.push(params.agentId);
	}
	if (params.source) {
		conditions.push("c.source = ?");
		paramsList.push(params.source);
	}
	const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
	const rows = params.db
		.prepare(
			`SELECT c.id, c.path, c.start_line, c.end_line, c.text,
				   c.source as source,
				   c.agent_id as agent_id,
				   vec_distance_cosine(v.embedding, ?) AS dist
			 FROM ${VECTOR_TABLE} v
			 JOIN ${CHUNKS_TABLE} c ON c.id = v.id${whereClause}
			 ORDER BY dist ASC
			 LIMIT ?`,
		)
		.all(vectorToBlob(params.queryVec), ...paramsList, params.limit) as Array<{
			id: string;
			path: string;
			start_line: number;
			end_line: number;
			text: string;
			dist: number;
			source?: string;
			agent_id?: string;
		}>;
	return rows.map((row) => ({
		id: row.id,
		path: row.path,
		startLine: row.start_line,
		endLine: row.end_line,
		vectorScore: 1 - row.dist,
		snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
		source: row.source === "sessions" ? "sessions" : "memory",
		agentId: row.agent_id,
	}));
}