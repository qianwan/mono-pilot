import type { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import type { MemorySource } from "../types.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import { chunkMarkdown, hashText, type MemoryChunk, type MemoryFileEntry } from "./files.js";
import { CHUNKS_TABLE, FTS_TABLE, VECTOR_TABLE } from "../store/schema.js";
import { embedChunks } from "./embeddings.js";

const DEFAULT_MODEL_ID = "fts";

export async function indexMemoryFile(params: {
	db: DatabaseSync;
	entry: MemoryFileEntry;
	source: MemorySource;
	chunking: { tokens: number; overlap: number };
	ftsAvailable: boolean;
	embeddings?: {
		provider: EmbeddingProvider;
		providerKey: string;
		cache: { enabled: boolean; maxEntries?: number };
		vector: { enabled: boolean; ensureReady: (dimensions: number) => Promise<boolean> };
	};
}): Promise<void> {
	const content = await readContent(params.entry);
	const chunks = chunkMarkdown(content, params.chunking).filter((chunk) => chunk.text.trim().length > 0);
	const now = Date.now();
	const modelId = params.embeddings ? params.embeddings.provider.model : DEFAULT_MODEL_ID;
	const vectorEnabled = params.embeddings?.vector.enabled ?? false;

	if (vectorEnabled) {
		try {
			params.db
				.prepare(
					`DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM ${CHUNKS_TABLE} WHERE path = ? AND source = ?)`,
				)
				.run(params.entry.path, params.source);
		} catch {
			// Ignore vector cleanup errors.
		}
	}
	params.db.prepare(`DELETE FROM ${CHUNKS_TABLE} WHERE path = ? AND source = ?`).run(
		params.entry.path,
		params.source,
	);
	if (params.ftsAvailable) {
		try {
			params.db
				.prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ? AND model = ?`)
				.run(params.entry.path, params.source, modelId);
		} catch {
			// Ignore FTS cleanup errors.
		}
	}

	let indexedChunks = chunks;
	let embeddings: number[][] = indexedChunks.map(() => []);
	if (params.embeddings) {
		const embedded = await embedChunks({
			db: params.db,
			provider: params.embeddings.provider,
			providerKey: params.embeddings.providerKey,
			chunks: indexedChunks,
			cache: params.embeddings.cache,
		});
		indexedChunks = embedded.chunks;
		embeddings = embedded.embeddings;
	}

	const sampleEmbedding = embeddings.find((embedding) => embedding.length > 0);
	const vectorReady =
		vectorEnabled && params.embeddings && sampleEmbedding
			? await params.embeddings.vector.ensureReady(sampleEmbedding.length)
			: false;

	for (let i = 0; i < indexedChunks.length; i += 1) {
		const chunk = indexedChunks[i];
		if (!chunk) continue;
		const embedding = embeddings[i] ?? [];
		const id = buildChunkId({
			source: params.source,
			path: params.entry.path,
			chunk,
			modelId,
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
				modelId,
				chunk.text,
				JSON.stringify(embedding),
				now,
			);
		if (vectorReady && embedding.length > 0) {
			try {
				params.db
					.prepare(`INSERT INTO ${VECTOR_TABLE} (id, embedding) VALUES (?, ?)`)
					.run(id, vectorToBlob(embedding));
			} catch {
				// Ignore vector insert errors.
			}
		}
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
						modelId,
						chunk.startLine,
						chunk.endLine,
					);
			} catch {
				// Ignore FTS insert errors.
			}
		}
	}
}

function buildChunkId(params: {
	source: MemorySource;
	path: string;
	chunk: MemoryChunk;
	modelId: string;
}): string {
	return hashText(
		`${params.source}:${params.path}:${params.chunk.startLine}:${params.chunk.endLine}:${params.chunk.hash}:${params.modelId}`,
	);
}

async function readContent(entry: MemoryFileEntry): Promise<string> {
	return await readFile(entry.absPath, "utf-8");
}

function vectorToBlob(embedding: number[]): Buffer {
	return Buffer.from(new Float32Array(embedding).buffer);
}