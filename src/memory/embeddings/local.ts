import type { Llama, LlamaEmbeddingContext, LlamaModel, LlamaLogLevel } from "node-llama-cpp";
import { DEFAULT_LOCAL_MODEL, DEFAULT_MODEL_CACHE_DIR } from "./constants.js";
import { importNodeLlamaCpp } from "./node-llama.js";
import type { EmbeddingProvider } from "./types.js";

function normalizeEmbedding(vector: number[]): number[] {
	const sanitized = vector.map((value) => (Number.isFinite(value) ? value : 0));
	const magnitude = Math.sqrt(sanitized.reduce((sum, value) => sum + value * value, 0));
	if (magnitude < 1e-10) {
		return sanitized;
	}
	return sanitized.map((value) => value / magnitude);
}

export async function createLocalEmbeddingProvider(params: {
	modelPath?: string;
	modelCacheDir?: string;
}): Promise<EmbeddingProvider> {
	const modelPath = params.modelPath?.trim() || DEFAULT_LOCAL_MODEL;
	const modelCacheDir = params.modelCacheDir?.trim() || DEFAULT_MODEL_CACHE_DIR;

	const nodeLlamaCpp = await importNodeLlamaCpp();
	const { getLlama, resolveModelFile } = nodeLlamaCpp;
	const logLevel = (nodeLlamaCpp as any).LlamaLogLevel?.error as LlamaLogLevel | undefined;

	let llama: Llama | null = null;
	let model: LlamaModel | null = null;
	let context: LlamaEmbeddingContext | null = null;

	const ensureContext = async () => {
		if (!llama) {
			llama = await getLlama({ logLevel: logLevel ?? ("error" as LlamaLogLevel) });
		}
		if (!model) {
			const resolved = await resolveModelFile(modelPath, modelCacheDir);
			model = await llama!.loadModel({ modelPath: resolved });
		}
		if (!context) {
			context = await model!.createEmbeddingContext();
		}
		return context;
	};

	return {
		id: "local",
		model: modelPath,
		embedQuery: async (text) => {
			const ctx = await ensureContext();
			const embedding = await ctx.getEmbeddingFor(text);
			return normalizeEmbedding(Array.from(embedding.vector));
		},
		embedBatch: async (texts) => {
			const ctx = await ensureContext();
			const embeddings = await Promise.all(
				texts.map(async (text) => {
					const embedding = await ctx.getEmbeddingFor(text);
					return normalizeEmbedding(Array.from(embedding.vector));
				}),
			);
			return embeddings;
		},
		dispose: async () => {
			if (model) {
				await model.dispose();
			}
			context = null;
			model = null;
			llama = null;
		},
	};
}