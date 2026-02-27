import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { deriveAgentId } from "../src/brief/paths.js";
import { getMemorySearchManager } from "../src/memory/search-manager.js";

const DESCRIPTION =
	"Search the memory index for relevant snippets (agent memory only). Returns paths, line ranges, and scored excerpts.";

const memorySearchSchema = Type.Object({
	query: Type.String({ description: "Search query for memory snippets." }),
	maxResults: Type.Optional(
		Type.Number({ description: "Maximum number of results to return." }),
	),
	minScore: Type.Optional(Type.Number({ description: "Minimum relevance score to include." })),
});

type MemorySearchInput = Static<typeof memorySearchSchema>;

interface MemorySearchDetails {
	query: string;
	maxResults?: number;
	minScore?: number;
	resultCount: number;
}

function formatResultLine(params: {
	path: string;
	startLine: number;
	endLine: number;
	score: number;
	snippet: string;
	agentId?: string;
}): string {
	const score = params.score.toFixed(3);
	const location = `${params.path}:${params.startLine}-${params.endLine}`;
	const scopePrefix = params.agentId ? `[${params.agentId}] ` : "";
	return `${scopePrefix}${location} (score ${score})\n${params.snippet}`;
}

export default function memorySearchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		label: "Memory Search",
		name: "memory_search",
		description: DESCRIPTION,
		parameters: memorySearchSchema,
		execute: async (_toolCallId, params: MemorySearchInput, _signal, _onUpdate, ctx) => {
			const query = params.query.trim();
			const maxResults = params.maxResults;
			const minScore = params.minScore;
			const manager = await getMemorySearchManager({
				workspaceDir: ctx.cwd,
				agentId: deriveAgentId(ctx.cwd),
			});
			if (!manager) {
				return {
					content: [
						{
							type: "text",
							text: "Memory search is disabled or unavailable.",
						},
					],
					details: {
						query,
						maxResults,
						minScore,
						resultCount: 0,
					},
				};
			}
			try {
				const results = await manager.search(query, { maxResults, minScore });
				const lines = results.map((result) =>
					formatResultLine({
						path: result.path,
						startLine: result.startLine,
						endLine: result.endLine,
						score: result.score,
						snippet: result.snippet,
						agentId: result.agentId,
					}),
				);
				const output = lines.length > 0 ? lines.join("\n\n") : "No memory matches found.";
				const details: MemorySearchDetails = {
					query,
					maxResults,
					minScore,
					resultCount: results.length,
				};
				return {
					content: [{ type: "text", text: output }],
					details,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Memory search failed: ${message}` }],
					details: { query, maxResults, minScore, resultCount: 0 },
				};
			}
		},
	});
}