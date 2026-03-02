/**
 * Embedding service handler for the cluster leader.
 * Handles "embed" RPC requests by delegating to the local embedding provider.
 */
import type { EmbeddingProvider } from "../../memory/embeddings/types.js";
import type { EmbedBatchParams, EmbedBatchResult } from "../protocol.js";
import type { ServiceHandler, RequestContext } from "../leader.js";
import { clusterLog } from "../log.js";

export function createEmbeddingHandler(provider: EmbeddingProvider): ServiceHandler {
	return {
		methods: ["embed"],

		async handle(req, ctx) {
			const { texts } = req.params as EmbedBatchParams;
			clusterLog.debug("embed request", { count: texts.length, reqId: req.id, ...req.from });
			const vectors = await provider.embedBatch(texts);
			ctx.respond({ result: { vectors } satisfies EmbedBatchResult });
		},
	};
}