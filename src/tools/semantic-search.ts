import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";

const MAX_RAW_MATCHES = 300;
const MAX_RETURNED_MATCHES = 40;
const MAX_LINE_CHARS = 240;
const MONOPILOT_IGNORE_FILENAME = ".monopilotignore";

const DESCRIPTION = readFileSync(fileURLToPath(new URL("./semantic-search-description.md", import.meta.url)), "utf-8").trim();

const STOP_WORDS = new Set([
	"the",
	"a",
	"an",
	"and",
	"or",
	"but",
	"for",
	"with",
	"from",
	"into",
	"onto",
	"that",
	"this",
	"these",
	"those",
	"what",
	"where",
	"when",
	"which",
	"who",
	"how",
	"why",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"to",
	"of",
	"in",
	"on",
	"at",
	"by",
	"as",
	"it",
	"its",
	"they",
	"them",
	"their",
	"you",
	"your",
	"we",
	"our",
	"before",
	"after",
	"during",
	"does",
	"do",
	"did",
	"can",
	"could",
	"should",
	"would",
	"about",
]);

const semanticSearchSchema = Type.Object({
	query: Type.String({
		description:
			"A complete question about what you want to understand. Ask as if talking to a colleague: 'How does X work?', 'What happens when Y?', 'Where is Z handled?'",
	}),
	target_directories: Type.Array(
		Type.String({
			description: "Prefix directory paths to limit search scope (single directory only, no glob patterns)",
		}),
	),
});

type SemanticSearchInput = Static<typeof semanticSearchSchema>;

interface SemanticSearchDetails {
	query: string;
	search_path: string;
	token_count: number;
	raw_matches: number;
	returned_matches: number;
	raw_match_limit_reached?: boolean;
}

interface RawMatch {
	filePath: string;
	lineNumber: number;
	lineText: string;
	score: number;
}

interface RgResult {
	code: number | null;
	stderr: string;
	matches: RawMatch[];
	limitReached: boolean;
}

function normalizeText(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenizeQuery(query: string): string[] {
	const tokens = query.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
	const filtered: string[] = [];
	const seen = new Set<string>();
	for (const token of tokens) {
		if (token.length < 3) continue;
		if (STOP_WORDS.has(token)) continue;
		if (seen.has(token)) continue;
		seen.add(token);
		filtered.push(token);
		if (filtered.length >= 12) break;
	}
	return filtered;
}

function resolveSearchPath(targetDirectories: string[], workspaceCwd: string): string {
	if (targetDirectories.length === 0) return workspaceCwd;
	if (targetDirectories.length > 1) {
		throw new Error("target_directories must contain exactly one entry or be empty ([]).");
	}

	const rawPath = targetDirectories[0]?.trim() ?? "";
	if (rawPath.length === 0) {
		throw new Error("target_directories[0] cannot be empty.");
	}
	if (rawPath.includes("*") || rawPath.includes("?")) {
		throw new Error("target_directories does not support glob or wildcard patterns.");
	}

	const resolvedPath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(workspaceCwd, rawPath);
	if (!existsSync(resolvedPath)) {
		throw new Error(`Search path does not exist: ${resolvedPath}`);
	}
	return resolvedPath;
}

function resolveMonopilotIgnorePath(workspaceCwd: string): string | undefined {
	const ignorePath = resolve(workspaceCwd, MONOPILOT_IGNORE_FILENAME);
	if (!existsSync(ignorePath)) return undefined;
	return ignorePath;
}

function formatPathForOutput(filePath: string, workspaceCwd: string): string {
	const normalized = isAbsolute(filePath) ? resolve(filePath) : resolve(workspaceCwd, filePath);
	const rel = relative(workspaceCwd, normalized);
	if (rel === "") return ".";
	if (!rel.startsWith("..") && !isAbsolute(rel)) {
		return rel.replace(/\\/g, "/");
	}
	return normalized.replace(/\\/g, "/");
}

function compactLineText(text: string): string {
	const oneLine = normalizeText(text).replace(/\s+/g, " ").trim();
	if (oneLine.length <= MAX_LINE_CHARS) return oneLine;
	return `${oneLine.slice(0, MAX_LINE_CHARS - 1)}…`;
}

function scoreMatch(filePath: string, lineText: string, tokens: string[], queryLower: string): number {
	const fileLower = filePath.toLowerCase();
	const lineLower = lineText.toLowerCase();

	let score = 0;
	if (queryLower.length >= 6 && lineLower.includes(queryLower)) {
		score += 5;
	}

	for (const token of tokens) {
		if (lineLower.includes(token)) score += 3;
		if (fileLower.includes(token)) score += 1;
	}

	return score;
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(line) as unknown;
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function getString(obj: Record<string, unknown>, key: string): string | undefined {
	const value = obj[key];
	return typeof value === "string" ? value : undefined;
}

function getNumber(obj: Record<string, unknown>, key: string): number | undefined {
	const value = obj[key];
	return typeof value === "number" ? value : undefined;
}

async function runSemanticRg(
	regexPattern: string,
	searchPath: string,
	tokens: string[],
	queryLower: string,
	workspaceCwd: string,
	signal?: AbortSignal,
): Promise<RgResult> {
	return new Promise((resolveResult, rejectResult) => {
		const args = ["--json", "-n", "--color=never", "-i", "--max-count", "8"];
		const monopilotIgnorePath = resolveMonopilotIgnorePath(workspaceCwd);
		if (monopilotIgnorePath) {
			args.push("--ignore-file", monopilotIgnorePath);
		}
		args.push("--", regexPattern, searchPath);

		const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
		const rl = createInterface({ input: child.stdout });
		const stderrChunks: Buffer[] = [];

		const matches: RawMatch[] = [];
		let limitReached = false;
		let aborted = false;
		let settled = false;

		const settle = (callback: () => void) => {
			if (settled) return;
			settled = true;
			callback();
		};

		const cleanup = () => {
			rl.close();
			if (signal) signal.removeEventListener("abort", onAbort);
		};

		const stopChild = () => {
			if (!child.killed) child.kill();
		};

		const onAbort = () => {
			aborted = true;
			stopChild();
		};

		if (signal) {
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		child.stderr?.on("data", (chunk: Buffer) => {
			stderrChunks.push(chunk);
		});

		rl.on("line", (line) => {
			if (matches.length >= MAX_RAW_MATCHES) return;
			const event = parseJsonLine(line);
			if (!event) return;
			if (getString(event, "type") !== "match") return;

			const data = event.data as Record<string, unknown> | undefined;
			if (!data || typeof data !== "object") return;
			const pathObj = data.path as Record<string, unknown> | undefined;
			const linesObj = data.lines as Record<string, unknown> | undefined;
			if (!pathObj || !linesObj) return;

			const filePath = getString(pathObj, "text");
			const lineNumber = getNumber(data, "line_number");
			const lineText = getString(linesObj, "text");
			if (!filePath || lineNumber === undefined || !lineText) return;

			const score = scoreMatch(filePath, lineText, tokens, queryLower);
			matches.push({ filePath, lineNumber, lineText, score });

			if (matches.length >= MAX_RAW_MATCHES) {
				limitReached = true;
				stopChild();
			}
		});

		child.on("error", (error) => {
			cleanup();
			settle(() => rejectResult(new Error(`Failed to run semantic ripgrep: ${error.message}`)));
		});

		child.on("close", (code) => {
			cleanup();
			if (aborted) {
				settle(() => rejectResult(new Error("Operation aborted")));
				return;
			}

			const stderr = Buffer.concat(stderrChunks).toString("utf-8");
			if (!limitReached && code !== 0 && code !== 1) {
				const message = stderr.trim() || `rg exited with code ${code}`;
				settle(() => rejectResult(new Error(message)));
				return;
			}

			settle(() =>
				resolveResult({
					code,
					stderr,
					matches,
					limitReached,
				}),
			);
		});
	});
}

function dedupeAndRankMatches(matches: RawMatch[]): RawMatch[] {
	const seen = new Set<string>();
	const unique: RawMatch[] = [];
	for (const match of matches) {
		const key = `${match.filePath}:${match.lineNumber}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(match);
	}

	unique.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
		return a.lineNumber - b.lineNumber;
	});

	return unique.slice(0, MAX_RETURNED_MATCHES);
}

function formatMatchesOutput(matches: RawMatch[], workspaceCwd: string): string {
	return matches
		.map((match) => {
			const filePath = formatPathForOutput(match.filePath, workspaceCwd);
			const snippet = compactLineText(match.lineText);
			return `${filePath}:${match.lineNumber}: ${snippet}`;
		})
		.join("\n");
}

export default function semanticSearchExtension(pi: ExtensionAPI) {
	// System prompt injection is handled centrally by system-prompt extension.

	pi.registerTool({
		name: "SemanticSearch",
		label: "SemanticSearch",
		description: DESCRIPTION,
		parameters: semanticSearchSchema,
		async execute(_toolCallId, params: SemanticSearchInput, signal, _onUpdate, ctx) {
			const query = params.query.trim();
			if (query.length === 0) {
				throw new Error("query cannot be empty.");
			}

			const searchPath = resolveSearchPath(params.target_directories, ctx.cwd);
			const tokens = tokenizeQuery(query);
			const queryLower = query.toLowerCase();
			const searchTerms = tokens.length > 0 ? tokens : queryLower.split(/\s+/).filter((part) => part.length > 0);
			const escapedTerms = searchTerms.map((term) => escapeRegex(term)).filter((term) => term.length > 0);
			if (escapedTerms.length === 0) {
				throw new Error("Unable to derive searchable terms from query.");
			}

			const regexPattern = escapedTerms.length === 1 ? escapedTerms[0] : `(${escapedTerms.join("|")})`;
			const rgResult = await runSemanticRg(regexPattern, searchPath, searchTerms, queryLower, ctx.cwd, signal);
			const rankedMatches = dedupeAndRankMatches(rgResult.matches);

			if (rankedMatches.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "No semantic matches found. Try a more specific question or broaden target_directories to [].",
						},
					],
					details: {
						query,
						search_path: searchPath,
						token_count: searchTerms.length,
						raw_matches: rgResult.matches.length,
						returned_matches: 0,
						raw_match_limit_reached: rgResult.limitReached || undefined,
					} satisfies SemanticSearchDetails,
				};
			}

			let output = formatMatchesOutput(rankedMatches, ctx.cwd);
			if (rgResult.limitReached) {
				output += `\n\n[Raw semantic search limited to ${MAX_RAW_MATCHES} matches. Refine query or narrow target_directories.]`;
			}

			return {
				content: [{ type: "text", text: output }],
				details: {
					query,
					search_path: searchPath,
					token_count: searchTerms.length,
					raw_matches: rgResult.matches.length,
					returned_matches: rankedMatches.length,
					raw_match_limit_reached: rgResult.limitReached || undefined,
				} satisfies SemanticSearchDetails,
			};
		},
	});
}