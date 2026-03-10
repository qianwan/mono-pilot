import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { keyHint, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";

type AstGrepMode = "run" | "scan";
type OutputMode = "content" | "files_with_matches" | "count";
type Strictness = "cst" | "smart" | "ast" | "relaxed" | "signature";

const DESCRIPTION = `Search code structure using ast-grep (AST-aware search).

- Supports two modes: "run" (inline pattern) and "scan" (rule-based)
- Read-only by design: rewrite/update flags are intentionally not exposed
- Default mode is "run"
- Use output_mode to return content, unique files, or match counts
- For Python and other indentation-sensitive languages, provide syntactically complete patterns`;

const astGrepSchema = Type.Object({
	mode: Type.Optional(
		Type.Union([Type.Literal("run"), Type.Literal("scan")], {
			description: 'Execution mode: "run" for inline pattern search, "scan" for rule-based scanning. Default: "run".',
		}),
	),
	pattern: Type.Optional(
		Type.String({
			description: 'AST pattern used by mode="run" (required for run mode).',
		}),
	),
	path: Type.Optional(
		Type.String({
			description: "File or directory to search in. Defaults to workspace root.",
		}),
	),
	lang: Type.Optional(
		Type.String({
			description: "Language for pattern parsing in run mode (e.g. ts, js, python, go).",
		}),
	),
	selector: Type.Optional(
		Type.String({
			description: "AST node kind selector for run mode (maps to --selector).",
		}),
	),
	strictness: Type.Optional(
		Type.Union(
			[
				Type.Literal("cst"),
				Type.Literal("smart"),
				Type.Literal("ast"),
				Type.Literal("relaxed"),
				Type.Literal("signature"),
			],
			{
				description: "Pattern strictness for run mode.",
			},
		),
	),
	globs: Type.Optional(
		Type.Array(Type.String(), {
			description: "Include/exclude globs (maps to repeated --globs; use !prefix to exclude).",
		}),
	),
	rule: Type.Optional(
		Type.String({
			description: "Rule file path for scan mode (maps to --rule).",
		}),
	),
	inline_rules: Type.Optional(
		Type.String({
			description: "Inline YAML rule text for scan mode (maps to --inline-rules).",
		}),
	),
	filter: Type.Optional(
		Type.String({
			description: "Rule id regex filter for scan mode (maps to --filter).",
		}),
	),
	output_mode: Type.Optional(
		Type.Union([Type.Literal("content"), Type.Literal("files_with_matches"), Type.Literal("count")], {
			description:
				'Output mode: "content" shows matched snippets, "files_with_matches" returns unique file paths, "count" returns per-file counts. Default: "content".',
		}),
	),
	head_limit: Type.Optional(
		Type.Number({
			description: "Maximum entries returned after offset. Default: 50.",
			minimum: 0,
		}),
	),
	offset: Type.Optional(
		Type.Number({
			description: "Skip first N entries (pagination). Default: 0.",
			minimum: 0,
		}),
	),
});

type AstGrepInput = Static<typeof astGrepSchema>;

interface AstGrepMatch {
	file: string;
	line: number;
	column: number;
	snippet: string;
	ruleId?: string;
}

interface AstGrepExecutionResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

interface AstGrepDetails {
	mode: AstGrepMode;
	output_mode: OutputMode;
	search_path: string;
	offset: number;
	head_limit: number;
	returned_entries: number;
	total_entries_after_offset: number;
	head_limit_truncated?: boolean;
	match_count: number;
	rewrite_enabled: false;
}

function toNonNegativeInteger(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value) || Number.isNaN(value)) return fallback;
	return Math.max(0, Math.floor(value));
}

function normalizeTextOutput(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function compactWhitespace(text: string): string {
	const oneLine = normalizeTextOutput(text).replace(/\s+/g, " ").trim();
	if (oneLine.length <= 220) return oneLine;
	return `${oneLine.slice(0, 219)}…`;
}

function resolveSearchPath(pathArg: string | undefined, workspaceCwd: string): string {
	if (!pathArg || pathArg.trim().length === 0) return workspaceCwd;
	const resolvedPath = isAbsolute(pathArg) ? pathArg : resolve(workspaceCwd, pathArg);
	if (!existsSync(resolvedPath)) {
		throw new Error(`Search path does not exist: ${resolvedPath}`);
	}
	return resolvedPath;
}

function resolveRulePath(pathArg: string, workspaceCwd: string): string {
	const resolvedPath = isAbsolute(pathArg) ? pathArg : resolve(workspaceCwd, pathArg);
	if (!existsSync(resolvedPath)) {
		throw new Error(`Rule file does not exist: ${resolvedPath}`);
	}
	return resolvedPath;
}

function buildRunArgs(input: AstGrepInput, searchPath: string): string[] {
	const pattern = input.pattern?.trim();
	if (!pattern) {
		throw new Error('pattern is required when mode="run".');
	}

	const args: string[] = ["run", "--pattern", pattern, "--json=stream"];
	if (input.lang?.trim()) args.push("--lang", input.lang.trim());
	if (input.selector?.trim()) args.push("--selector", input.selector.trim());
	if (input.strictness) args.push("--strictness", input.strictness as Strictness);
	for (const glob of input.globs ?? []) {
		if (glob.trim().length === 0) continue;
		args.push("--globs", glob);
	}
	args.push(searchPath);
	return args;
}

function buildScanArgs(input: AstGrepInput, searchPath: string, workspaceCwd: string): string[] {
	if (input.rule && input.inline_rules) {
		throw new Error('scan mode accepts either "rule" or "inline_rules", not both.');
	}

	const args: string[] = ["scan", "--json=stream"];
	if (input.rule?.trim()) {
		args.push("--rule", resolveRulePath(input.rule.trim(), workspaceCwd));
	}
	if (input.inline_rules?.trim()) {
		args.push("--inline-rules", input.inline_rules);
	}
	if (input.filter?.trim()) {
		args.push("--filter", input.filter.trim());
	}
	for (const glob of input.globs ?? []) {
		if (glob.trim().length === 0) continue;
		args.push("--globs", glob);
	}
	args.push(searchPath);
	return args;
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(line) as unknown;
		if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
		return undefined;
	} catch {
		return undefined;
	}
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function parseMatches(stdout: string): AstGrepMatch[] {
	const lines = normalizeTextOutput(stdout).split("\n");
	const matches: AstGrepMatch[] = [];

	for (const rawLine of lines) {
		if (rawLine.trim().length === 0) continue;
		const payload = parseJsonLine(rawLine);
		if (!payload) continue;

		const file = getString(payload, "file");
		if (!file) continue;

		const range = payload.range;
		if (typeof range !== "object" || range === null) continue;
		const start = (range as Record<string, unknown>).start;
		if (typeof start !== "object" || start === null) continue;
		const lineRaw = (start as Record<string, unknown>).line;
		const colRaw = (start as Record<string, unknown>).column;
		const line = typeof lineRaw === "number" ? lineRaw + 1 : 1;
		const column = typeof colRaw === "number" ? colRaw + 1 : 1;

		const snippet = compactWhitespace(getString(payload, "lines") ?? getString(payload, "text") ?? "");
		const ruleId = getString(payload, "ruleId");
		matches.push({
			file,
			line,
			column,
			snippet,
			ruleId,
		});
	}

	return matches;
}

function uniqueFiles(matches: AstGrepMatch[]): string[] {
	const seen = new Set<string>();
	const files: string[] = [];
	for (const match of matches) {
		if (seen.has(match.file)) continue;
		seen.add(match.file);
		files.push(match.file);
	}
	return files;
}

function fileCounts(matches: AstGrepMatch[]): string[] {
	const counts = new Map<string, number>();
	for (const match of matches) {
		counts.set(match.file, (counts.get(match.file) ?? 0) + 1);
	}
	return Array.from(counts.entries())
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([file, count]) => `${file}:${count}`);
}

function applyPagination(entries: string[], offset: number, headLimit: number): {
	pagedEntries: string[];
	totalAfterOffset: number;
	headLimitTruncated: boolean;
} {
	const start = Math.min(offset, entries.length);
	const afterOffset = entries.slice(start);
	const pagedEntries = afterOffset.slice(0, headLimit);
	return {
		pagedEntries,
		totalAfterOffset: afterOffset.length,
		headLimitTruncated: afterOffset.length > pagedEntries.length,
	};
}

async function runAstGrep(args: string[], cwd: string, signal?: AbortSignal): Promise<AstGrepExecutionResult> {
	return await new Promise<AstGrepExecutionResult>((resolvePromise, rejectPromise) => {
		const child = spawn("ast-grep", args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let settled = false;

		const cleanupAbort = () => {
			if (!signal) return;
			signal.removeEventListener("abort", onAbort);
		};

		const finalize = (result: AstGrepExecutionResult) => {
			if (settled) return;
			settled = true;
			cleanupAbort();
			resolvePromise(result);
		};

		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanupAbort();
			rejectPromise(error);
		};

		const onAbort = () => {
			child.kill("SIGTERM");
			fail(new Error("Operation aborted"));
		};

		if (signal) {
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}

		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf-8");
		});

		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8");
		});

		child.on("error", (error: Error & { code?: string }) => {
			if (error.code === "ENOENT") {
				fail(new Error("ast-grep executable not found in PATH. Install ast-grep and try again."));
				return;
			}
			fail(error);
		});

		child.on("close", (code) => {
			finalize({ code, stdout, stderr });
		});
	});
}

function resolveOutputEntries(matches: AstGrepMatch[], outputMode: OutputMode): string[] {
	if (outputMode === "files_with_matches") {
		return uniqueFiles(matches);
	}
	if (outputMode === "count") {
		return fileCounts(matches);
	}

	return matches.map((match) => {
		const rulePart = match.ruleId ? ` [rule=${match.ruleId}]` : "";
		return `${match.file}:${match.line}:${match.column}:${rulePart} ${match.snippet}`.trim();
	});
}

export default function astGrepExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "AstGrep",
		label: "AstGrep",
		description: DESCRIPTION,
		parameters: astGrepSchema,
		renderCall(args, theme) {
			const input = args as Partial<AstGrepInput>;
			const mode = input.mode === "scan" ? "scan" : "run";
			const mainArg =
				mode === "run"
					? (typeof input.pattern === "string" && input.pattern.trim().length > 0 ? input.pattern.trim() : "(missing pattern)")
					: (typeof input.rule === "string" && input.rule.trim().length > 0 ? input.rule.trim() : "(scan)");

			let text = theme.fg("toolTitle", theme.bold("AstGrep"));
			text += ` ${theme.fg("toolOutput", `${mode} ${mainArg}`)}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("muted", "Searching AST..."), 0, 0);
			}

			const textBlock = result.content.find(
				(entry): entry is { type: "text"; text: string } => entry.type === "text" && typeof entry.text === "string",
			);
			if (!textBlock) {
				return new Text(theme.fg("error", "No output."), 0, 0);
			}

			const fullText = textBlock.text;
			const lineCount = fullText.split("\n").filter((line) => line.trim().length > 0).length;

			if (!expanded) {
				const summary = `${lineCount} entries (click or ${keyHint("expandTools", "to expand")})`;
				return new Text(theme.fg("muted", summary), 0, 0);
			}

			let text = fullText
				.split("\n")
				.map((line: string) => theme.fg("toolOutput", line))
				.join("\n");
			text += theme.fg("muted", `\n(click or ${keyHint("expandTools", "to collapse")})`);
			return new Text(text, 0, 0);
		},
		async execute(_id, input: AstGrepInput, signal, _onUpdate, ctx) {
			const mode: AstGrepMode = input.mode === "scan" ? "scan" : "run";
			const outputMode: OutputMode =
				input.output_mode === "files_with_matches" || input.output_mode === "count" ? input.output_mode : "content";
			const offset = toNonNegativeInteger(input.offset, 0);
			const headLimit = toNonNegativeInteger(input.head_limit, 50);
			const searchPath = resolveSearchPath(input.path, ctx.cwd);

			const args =
				mode === "run" ? buildRunArgs(input, searchPath) : buildScanArgs(input, searchPath, ctx.cwd);

			const result = await runAstGrep(args, ctx.cwd, signal);
			const stderr = normalizeTextOutput(result.stderr).trim();

			if (result.code !== 0 && result.code !== 1) {
				throw new Error(stderr.length > 0 ? `ast-grep failed (${result.code}): ${stderr}` : `ast-grep failed (${result.code})`);
			}
			if (stderr.length > 0) {
				throw new Error(`ast-grep stderr: ${stderr}`);
			}

			const matches = parseMatches(result.stdout);
			const entries = resolveOutputEntries(matches, outputMode);
			const { pagedEntries, totalAfterOffset, headLimitTruncated } = applyPagination(entries, offset, headLimit);

			const text = pagedEntries.length > 0 ? pagedEntries.join("\n") : "No matches found.";
			const details: AstGrepDetails = {
				mode,
				output_mode: outputMode,
				search_path: searchPath,
				offset,
				head_limit: headLimit,
				returned_entries: pagedEntries.length,
				total_entries_after_offset: totalAfterOffset,
				head_limit_truncated: headLimitTruncated,
				match_count: matches.length,
				rewrite_enabled: false,
			};

			return {
				content: [{ type: "text" as const, text }],
				details,
			};
		},
	});
}