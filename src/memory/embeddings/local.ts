import type { Llama, LlamaEmbeddingContext, LlamaModel } from "node-llama-cpp";
import { DEFAULT_LOCAL_MODEL, DEFAULT_MODEL_CACHE_DIR } from "./constants.js";
import { importNodeLlamaCpp } from "./node-llama.js";
import type { EmbeddingProvider } from "./types.js";

const LLAMA_SUPPRESS_PATTERNS = [
	"model vocab missing newline token",
	"embeddings required but some input tokens were not marked as outputs",
];
let stderrFilterDepth = 0;
let stderrOriginalWrite: typeof process.stderr.write | null = null;

function normalizeEmbedding(vector: number[]): number[] {
	const sanitized = vector.map((value) => (Number.isFinite(value) ? value : 0));
	const magnitude = Math.sqrt(sanitized.reduce((sum, value) => sum + value * value, 0));
	if (magnitude < 1e-10) {
		return sanitized;
	}
	return sanitized.map((value) => value / magnitude);
}

async function withLlamaWarningFilter<T>(fn: () => Promise<T>): Promise<T> {
	if (stderrFilterDepth === 0) {
		stderrOriginalWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk, encodingOrCb, cb) => {
			const encoding = typeof encodingOrCb === "string" ? encodingOrCb : undefined;
			const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
			const text =
				typeof chunk === "string"
					? chunk
					: Buffer.from(chunk).toString(encoding ?? "utf8");
			if (LLAMA_SUPPRESS_PATTERNS.some((p) => text.includes(p))) {
				if (callback) callback();
				return true;
			}
			return stderrOriginalWrite?.(chunk as never, encodingOrCb as never, cb as never) ?? true;
		}) as typeof process.stderr.write;
	}
	stderrFilterDepth += 1;
	try {
		return await fn();
	} finally {
		stderrFilterDepth = Math.max(0, stderrFilterDepth - 1);
		if (stderrFilterDepth === 0 && stderrOriginalWrite) {
			process.stderr.write = stderrOriginalWrite;
			stderrOriginalWrite = null;
		}
	}
}

export async function createLocalEmbeddingProvider(params: {
	modelPath?: string;
	modelCacheDir?: string;
}): Promise<EmbeddingProvider> {
	const modelPath = params.modelPath?.trim() || DEFAULT_LOCAL_MODEL;
	const modelCacheDir = params.modelCacheDir?.trim() || DEFAULT_MODEL_CACHE_DIR;

	const { getLlama, resolveModelFile } = await importNodeLlamaCpp();

	let llama: Llama | null = null;
	let model: LlamaModel | null = null;
	let context: LlamaEmbeddingContext | null = null;

	const ensureContext = async () => {
		if (!llama) {
			llama = await getLlama();
		}
		if (!model) {
			const resolved = await resolveModelFile(modelPath, modelCacheDir);
			model = await withLlamaWarningFilter(async () => await llama!.loadModel({ modelPath: resolved }));
		}
		if (!context) {
			context = await withLlamaWarningFilter(async () => await model!.createEmbeddingContext());
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