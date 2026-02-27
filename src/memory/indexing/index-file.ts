import type { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import type { MemorySource } from "../types.js";
import { chunkMarkdown, hashText, type MemoryChunk, type MemoryFileEntry } from "./files.js";
import { CHUNKS_TABLE, FTS_TABLE } from "../store/tables.js";

const DEFAULT_MODEL_ID = "fts";

export async function indexMemoryFile(params: {
	db: DatabaseSync;
	entry: MemoryFileEntry;
	source: MemorySource;
	chunking: { tokens: number; overlap: number };
	ftsAvailable: boolean;
}): Promise<void> {
	const content = await readContent(params.entry);
	const chunks = chunkMarkdown(content, params.chunking).filter((chunk) => chunk.text.trim().length > 0);
	const now = Date.now();

	params.db.prepare(`DELETE FROM ${CHUNKS_TABLE} WHERE path = ? AND source = ?`).run(
		params.entry.path,
		params.source,
	);
	if (params.ftsAvailable) {
		try {
			params.db
				.prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ? AND model = ?`)
				.run(params.entry.path, params.source, DEFAULT_MODEL_ID);
		} catch {
			// Ignore FTS cleanup errors.
		}
	}

	for (const chunk of chunks) {
		const id = buildChunkId({
			source: params.source,
			path: params.entry.path,
			chunk,
		});
		params.db
			.prepare(
				`INSERT INTO ${CHUNKS_TABLE} (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
				   hash=excluded.hash,
				   model=excluded.model,
				   text=excluded.text,
				   embedding=excluded.embedding,
				   updated_at=excluded.updated_at`,
			)
			.run(
				id,
				params.entry.path,
				params.source,
				chunk.startLine,
				chunk.endLine,
				chunk.hash,
				DEFAULT_MODEL_ID,
				chunk.text,
				"[]",
				now,
			);
		if (params.ftsAvailable) {
			try {
				params.db
					.prepare(
						`INSERT INTO ${FTS_TABLE} (text, id, path, source, model, start_line, end_line)
						 VALUES (?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						chunk.text,
						id,
						params.entry.path,
						params.source,
						DEFAULT_MODEL_ID,
						chunk.startLine,
						chunk.endLine,
					);
			} catch {
				// Ignore FTS insert errors.
			}
		}
	}
}

function buildChunkId(params: { source: MemorySource; path: string; chunk: MemoryChunk }): string {
	return hashText(
		`${params.source}:${params.path}:${params.chunk.startLine}:${params.chunk.endLine}:${params.chunk.hash}:${DEFAULT_MODEL_ID}`,
	);
}

async function readContent(entry: MemoryFileEntry): Promise<string> {
	return await readFile(entry.absPath, "utf-8");
}