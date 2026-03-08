import type { EmbeddingProvider } from "../../memory/embeddings/types.js";
import type {
	ClusterRpcClient,
	EmbedBatchParams,
	EmbedBatchResult,
	RpcRequestHandler,
} from "../rpc.js";

export const EMBEDDING_METHOD_EMBED_BATCH = "embedding.embedBatch";

const DEFAULT_MAX_CONCURRENT_REQUESTS = 4;
const DEFAULT_MAX_TEXTS_PER_REQUEST = 16;

export interface EmbeddingHandlerOptions {
	maxConcurrentRequests?: number;
	maxTextsPerRequest?: number;
}

function toPositiveInteger(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	const normalized = Math.floor(value);
	if (normalized <= 0) {
		return fallback;
	}
	return normalized;
}

function parseEmbedBatchParams(params: unknown): EmbedBatchParams {
	if (!params || typeof params !== "object") {
		throw new Error("embedding.embedBatch requires object params");
	}
	const texts = (params as { texts?: unknown }).texts;
	if (!Array.isArray(texts) || texts.some((item) => typeof item !== "string")) {
		throw new Error("embedding.embedBatch requires string[] texts");
	}
	return { texts };
}

export function createEmbeddingHandlers(
	provider: EmbeddingProvider,
	options?: EmbeddingHandlerOptions,
): Record<string, RpcRequestHandler> {
	const maxConcurrentRequests = toPositiveInteger(
		options?.maxConcurrentRequests,
		DEFAULT_MAX_CONCURRENT_REQUESTS,
	);
	const maxTextsPerRequest = toPositiveInteger(options?.maxTextsPerRequest, DEFAULT_MAX_TEXTS_PER_REQUEST);
	let inFlight = 0;

	return {
		[EMBEDDING_METHOD_EMBED_BATCH]: async (request) => {
			const { texts } = parseEmbedBatchParams(request.params);
			if (texts.length > maxTextsPerRequest) {
				throw new Error(
					`embedding.embedBatch exceeded text limit ${maxTextsPerRequest}: got ${texts.length}`,
				);
			}
			if (inFlight >= maxConcurrentRequests) {
				throw new Error(
					`embedding service overloaded: in-flight limit ${maxConcurrentRequests} reached`,
				);
			}
			inFlight += 1;
			try {
				const vectors = await provider.embedBatch(texts);
				const result: EmbedBatchResult = { vectors };
				return result;
			} finally {
				inFlight = Math.max(0, inFlight - 1);
			}
		},
	};
}

export interface EmbeddingClientOptions {
	model: string;
	timeoutMs?: number;
}

export function createEmbeddingClient(client: ClusterRpcClient, options: EmbeddingClientOptions): EmbeddingProvider {
	const timeoutMs = options.timeoutMs ?? 30_000;

	return {
		id: "local",
		model: options.model,
		embedQuery: async (text) => {
			const result = await client.call<EmbedBatchResult>(
				EMBEDDING_METHOD_EMBED_BATCH,
				{ texts: [text] } satisfies EmbedBatchParams,
				{ timeoutMs },
			);
			return result.vectors[0] ?? [];
		},
		embedBatch: async (texts) => {
			const result = await client.call<EmbedBatchResult>(
				EMBEDDING_METHOD_EMBED_BATCH,
				{ texts } satisfies EmbedBatchParams,
				{ timeoutMs },
			);
			return result.vectors;
		},
		dispose: async () => {
			// lifecycle owns ClusterRpcClient and closes it.
		},
	};
}
