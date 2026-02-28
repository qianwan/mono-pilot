import type { ResolvedMemorySearchConfig } from "../config/types.js";
import { createLocalEmbeddingProvider } from "./local.js";
import type { EmbeddingProvider } from "./types.js";

export async function createEmbeddingProvider(
	settings: ResolvedMemorySearchConfig,
): Promise<EmbeddingProvider | null> {
	if (settings.provider !== "local") {
		return null;
	}
	return await createLocalEmbeddingProvider(settings.local);
}