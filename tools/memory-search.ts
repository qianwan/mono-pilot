import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { deriveAgentId } from "../src/brief/paths.js";
import { getMemorySearchManager } from "../src/memory/search-manager.js";

const DESCRIPTION =
	"Search the memory index for relevant snippets. Supports scope: self, agent, all. Returns paths, line ranges, and scored excerpts.";

const memorySearchSchema = Type.Object({
	query: Type.String({ description: "Search query for memory snippets." }),
	maxResults: Type.Optional(
		Type.Number({ description: "Maximum number of results to return." }),
	),
	minScore: Type.Optional(Type.Number({ description: "Minimum relevance score to include." })),
	scope: Type.Optional(
		Type.Union(
			[Type.Literal("self"), Type.Literal("agent"), Type.Literal("all")],
			{ description: "Search scope." },
		),
	),
	targetAgentId: Type.Optional(
		Type.String({ description: "Target agent ID (required when scope=agent)." }),
	),
});

type MemorySearchInput = Static<typeof memorySearchSchema>;

const MAX_RENDER_QUERY_CHARS = 120;
const MAX_RENDER_AGENTID_CHARS = 120;

function compactForCommandArg(value: string, maxLength: number): string {
	const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\\n").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function shellQuoteArg(value: string): string {
	if (value.length === 0) return "''";
	if (/^[A-Za-z0-9_./:=,+-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `"'"'"'`)}'`;
}

interface MemorySearchDetails {
	query: string;
	maxResults?: number;
	minScore?: number;
	scope: "self" | "agent" | "all";
	targetAgentId?: string;
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
		label: "MemorySearch",
		name: "MemorySearch",
		description: DESCRIPTION,
		parameters: memorySearchSchema,
		renderCall(args, theme) {
			const input = args as Partial<MemorySearchInput>;
			const rawQuery = typeof input.query === "string" ? input.query : "";
			const query = rawQuery.trim().length > 0
				? compactForCommandArg(rawQuery, MAX_RENDER_QUERY_CHARS)
				: "(missing query)";
			const scope = input.scope;
			const targetAgentId =
				typeof input.targetAgentId === "string" && input.targetAgentId.trim().length > 0
					? compactForCommandArg(input.targetAgentId, MAX_RENDER_AGENTID_CHARS)
					: undefined;

			const commandArgs = [query];
			if (scope) commandArgs.push("--scope", scope);
			if (targetAgentId) commandArgs.push("--target-agent-id", targetAgentId);
			const commandText = commandArgs.map(shellQuoteArg).join(" ");

			let text = theme.fg("toolTitle", theme.bold("MemorySearch"));
			text += ` ${theme.fg("toolOutput", commandText)}`;
			return new Text(text, 0, 0);
		},
		execute: async (_toolCallId, params: MemorySearchInput, _signal, _onUpdate, ctx) => {
			const query = params.query.trim();
			const maxResults = params.maxResults;
			const minScore = params.minScore;
			const scope = params.scope ?? "self";
			const targetAgentId = params.targetAgentId;
			if (scope === "agent" && !targetAgentId) {
				return {
					content: [
						{
							type: "text",
							text: "targetAgentId is required when scope=agent.",
						},
					],
					details: {
						query,
						maxResults,
						minScore,
						scope,
						targetAgentId,
						resultCount: 0,
					},
				};
			}
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
						scope,
						targetAgentId,
						resultCount: 0,
					},
				};
			}
			try {
				const results = await manager.search(query, {
					maxResults,
					minScore,
					scope,
					targetAgentId,
				});
				const includeAgentId = scope !== "self";
				const lines = results.map((result) =>
					formatResultLine({
						path: result.path,
						startLine: result.startLine,
						endLine: result.endLine,
						score: result.score,
						snippet: result.snippet,
						agentId: includeAgentId ? result.agentId : undefined,
					}),
				);
				const output = lines.length > 0 ? lines.join("\n\n") : "No memory matches found.";
				const details: MemorySearchDetails = {
					query,
					maxResults,
					minScore,
					scope,
					targetAgentId,
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
					details: { query, maxResults, minScore, scope, targetAgentId, resultCount: 0 },
				};
			}
		},
	});
}
