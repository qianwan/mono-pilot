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
}

export async function searchVector(params: {
	db: DatabaseSync;
	queryVec: number[];
	limit: number;
	snippetMaxChars: number;
	model?: string;
}): Promise<VectorSearchResult[]> {
	if (params.queryVec.length === 0 || params.limit <= 0) {
		return [];
	}
	const modelClause = params.model ? " WHERE c.model = ?" : "";
	const modelParams = params.model ? [params.model] : [];
	const rows = params.db
		.prepare(
			`SELECT c.id, c.path, c.start_line, c.end_line, c.text,
				   vec_distance_cosine(v.embedding, ?) AS dist
			 FROM ${VECTOR_TABLE} v
			 JOIN ${CHUNKS_TABLE} c ON c.id = v.id${modelClause}
			 ORDER BY dist ASC
			 LIMIT ?`,
		)
		.all(vectorToBlob(params.queryVec), ...modelParams, params.limit) as Array<{
			id: string;
			path: string;
			start_line: number;
			end_line: number;
			text: string;
			dist: number;
		}>;
	return rows.map((row) => ({
		id: row.id,
		path: row.path,
		startLine: row.start_line,
		endLine: row.end_line,
		vectorScore: 1 - row.dist,
		snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
	}));
}