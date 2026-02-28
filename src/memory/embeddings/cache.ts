import type { DatabaseSync } from "node:sqlite";
import { EMBEDDING_CACHE_TABLE } from "../store/schema.js";

export function readEmbeddingCache(params: {
	db: DatabaseSync;
	provider: string;
	model: string;
	providerKey: string;
	hash: string;
}): number[] | null {
	const row = params.db
		.prepare(
			`SELECT embedding FROM ${EMBEDDING_CACHE_TABLE} WHERE provider = ? AND model = ? AND provider_key = ? AND hash = ?`,
		)
		.get(params.provider, params.model, params.providerKey, params.hash) as
		| { embedding: string }
		| undefined;
	if (!row?.embedding) return null;
	try {
		const parsed = JSON.parse(row.embedding) as number[];
		return Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export function writeEmbeddingCache(params: {
	db: DatabaseSync;
	provider: string;
	model: string;
	providerKey: string;
	hash: string;
	embedding: number[];
}): void {
	const now = Date.now();
	params.db
		.prepare(
			`INSERT INTO ${EMBEDDING_CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET
			   embedding=excluded.embedding,
			   dims=excluded.dims,
			   updated_at=excluded.updated_at`,
		)
		.run(
			params.provider,
			params.model,
			params.providerKey,
			params.hash,
			JSON.stringify(params.embedding),
			params.embedding.length,
			now,
		);
}

export function pruneEmbeddingCache(params: {
	db: DatabaseSync;
	provider: string;
	model: string;
	providerKey: string;
	maxEntries?: number;
}): void {
	const maxEntries = params.maxEntries;
	if (!maxEntries || maxEntries <= 0) return;
	const countRow = params.db
		.prepare(
			`SELECT COUNT(*) AS count FROM ${EMBEDDING_CACHE_TABLE} WHERE provider = ? AND model = ? AND provider_key = ?`,
		)
		.get(params.provider, params.model, params.providerKey) as { count: number } | undefined;
	const count = countRow?.count ?? 0;
	if (count <= maxEntries) return;
	const toDelete = count - maxEntries;
	params.db
		.prepare(
			`DELETE FROM ${EMBEDDING_CACHE_TABLE}
			 WHERE rowid IN (
				SELECT rowid FROM ${EMBEDDING_CACHE_TABLE}
				 WHERE provider = ? AND model = ? AND provider_key = ?
				 ORDER BY updated_at ASC
				 LIMIT ?
			 )`,
		)
		.run(params.provider, params.model, params.providerKey, toDelete);
}