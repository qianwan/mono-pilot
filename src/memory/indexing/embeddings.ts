import type { DatabaseSync } from "node:sqlite";
import type { EmbeddingProvider } from "../embeddings/types.js";
import { enforceEmbeddingMaxInputTokens } from "../embeddings/chunk-limits.js";
import { runEmbeddingBatches } from "../embeddings/batch-runner.js";
import { readEmbeddingCache, writeEmbeddingCache, pruneEmbeddingCache } from "../embeddings/cache.js";
import type { MemoryChunk } from "./files.js";

const DEFAULT_BATCH_SIZE = 16;
const DEFAULT_BATCH_CONCURRENCY = 2;

export async function embedChunks(params: {
	db: DatabaseSync;
	provider: EmbeddingProvider;
	providerKey: string;
	chunks: MemoryChunk[];
	cache: { enabled: boolean; maxEntries?: number };
}): Promise<{ chunks: MemoryChunk[]; embeddings: number[][] }> {
	const limited = enforceEmbeddingMaxInputTokens(params.provider, params.chunks);
	const embeddings: number[][] = Array.from({ length: limited.length });

	const pendingTexts: string[] = [];
	const pendingIndices: number[] = [];
	for (let i = 0; i < limited.length; i += 1) {
		const chunk = limited[i];
		if (!chunk) continue;
		if (params.cache.enabled) {
			const cached = readEmbeddingCache({
				db: params.db,
				provider: params.provider.id,
				model: params.provider.model,
				providerKey: params.providerKey,
				hash: chunk.hash,
			});
			if (cached) {
				embeddings[i] = cached;
				continue;
			}
		}
		pendingTexts.push(chunk.text);
		pendingIndices.push(i);
	}

	if (pendingTexts.length > 0) {
		const embedded = await runEmbeddingBatches({
			items: pendingTexts,
			maxBatchSize: DEFAULT_BATCH_SIZE,
			concurrency: DEFAULT_BATCH_CONCURRENCY,
			runBatch: async (batch) => params.provider.embedBatch(batch),
		});
		for (let i = 0; i < pendingIndices.length; i += 1) {
			const index = pendingIndices[i];
			const embedding = embedded[i] ?? [];
			embeddings[index] = embedding;
			if (params.cache.enabled) {
				const chunk = limited[index];
				if (chunk) {
					writeEmbeddingCache({
						db: params.db,
						provider: params.provider.id,
						model: params.provider.model,
						providerKey: params.providerKey,
						hash: chunk.hash,
						embedding,
					});
				}
			}
		}
		if (params.cache.enabled) {
			pruneEmbeddingCache({
				db: params.db,
				provider: params.provider.id,
				model: params.provider.model,
				providerKey: params.providerKey,
				maxEntries: params.cache.maxEntries,
			});
		}
	}

	return { chunks: limited, embeddings };
}