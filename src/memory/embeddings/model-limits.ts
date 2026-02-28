import type { EmbeddingProvider } from "./types.js";

const DEFAULT_LOCAL_MAX_INPUT_TOKENS = 2048;

export function resolveEmbeddingMaxInputTokens(provider: EmbeddingProvider): number {
	if (typeof provider.maxInputTokens === "number") {
		return provider.maxInputTokens;
	}
	return DEFAULT_LOCAL_MAX_INPUT_TOKENS;
}