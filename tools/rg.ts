import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	formatSize,
	keyHint,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";

const MONOPILOT_IGNORE_FILENAME = ".monopilotignore";

type OutputMode = "content" | "files_with_matches" | "count";

const DESCRIPTION = `Search the workspace with ripgrep.

- Use this tool instead of shell rg; respects .gitignore and .monopilotignore
- Default scope is the workspace root; set path (absolute path) to narrow it
- Supply a regex pattern; escape metacharacters, e.g. "functionCall\(", "\{", "\}"
- Prefer type over broad glob; wildcard globs like * bypass ignore rules and slow searches
- Enable multiline only when a match spans lines—it can degrade performance
- Context flags (-A, -B, -C) only affect content output
- If results show "at least …", the output was truncated; tighten the query or raise head_limit`;

const rgSchema = Type.Object({
	pattern: Type.String({ description: "The regular expression pattern to search for in file contents" }),
	path: Type.Optional(
		Type.String({
			description: "File or directory to search in (rg pattern -- PATH). Defaults to MonoPilot workspace root.",
		}),
	),
	glob: Type.Optional(
		Type.String({
			description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob',
		}),
	),
	output_mode: Type.Optional(
		Type.Union([Type.Literal("content"), Type.Literal("files_with_matches"), Type.Literal("count")], {
			description:
				'Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "content".',
		}),
	),
	"-B": Type.Optional(
		Type.Number({
			description:
				'Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.',
		}),
	),
	"-A": Type.Optional(
		Type.Number({
			description:
				'Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.',
		}),
	),
	"-C": Type.Optional(
		Type.Number({
			description:
				'Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.',
		}),
	),
	"-i": Type.Optional(Type.Boolean({ description: "Case insensitive search (rg -i) Defaults to false" })),
	type: Type.Optional(
		Type.String({
			description:
				"File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.",
		}),
	),
	head_limit: Type.Optional(
		Type.Number({
			description:
				'Limit output size. For "content" mode: limits total matches shown. For "files_with_matches" and "count" modes: limits number of files.',
			minimum: 0,
		}),
	),
	offset: Type.Optional(
		Type.Number({
			description:
				'Skip first N entries. For "content" mode: skips first N matches. For "files_with_matches" and "count" modes: skips first N files. Use with head_limit for pagination.',
			minimum: 0,
		}),
	),
	multiline: Type.Optional(
		Type.Boolean({
			description:
				"Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.",
		}),
	),
});

type RgInput = Static<typeof rgSchema>;

interface RgExecutionResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

interface RgToolDetails {
	output_mode: OutputMode;
	search_path: string;
	offset: number;
	head_limit?: number;
	returned_entries: number;
	total_entries_after_offset: number;
	head_limit_truncated?: boolean;
	content_truncated?: boolean;
}

interface ParsedContentResult {
	entries: string[];
	matchCount: number;
}

interface ContentLineRecord {
	kind: "match" | "context";
	text: string;
}

interface MatchSpan {
	path: string;
	startLine: number;
	endLine: number;
}

function normalizeTextOutput(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function toNonNegativeInteger(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value) || Number.isNaN(value)) return undefined;
	return Math.max(0, Math.floor(value));
}

function resolveSearchPath(pathArg: string | undefined, workspaceCwd: string): string {
	if (!pathArg || pathArg.trim().length === 0) return workspaceCwd;
	const resolvedPath = isAbsolute(pathArg) ? pathArg : resolve(workspaceCwd, pathArg);
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

function parseJsonLine(line: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(line) as unknown;
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function getNumber(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" ? value : undefined;
}

function splitEventLines(text: string): string[] {
	const normalized = normalizeTextOutput(text);
	const withoutTrailingNewline = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
	return withoutTrailingNewline.split("\n");
}

function ensurePathLineMap(
	pathLineMap: Map<string, Map<number, ContentLineRecord>>,
	path: string,
): Map<number, ContentLineRecord> {
	const existing = pathLineMap.get(path);
	if (existing) return existing;
	const created = new Map<number, ContentLineRecord>();
	pathLineMap.set(path, created);
	return created;
}

function parseContentEvents(
	stdout: string,
	beforeContext: number,
	afterContext: number,
): ParsedContentResult {
	const normalized = normalizeTextOutput(stdout).trim();
	if (!normalized) {
		return { entries: [], matchCount: 0 };
	}

	const pathLineMap = new Map<string, Map<number, ContentLineRecord>>();
	const matchSpans: MatchSpan[] = [];

	for (const line of normalized.split("\n")) {
		const event = parseJsonLine(line);
		if (!event) continue;

		const type = getString(event, "type");
		if (type !== "match" && type !== "context") continue;

		const data = event.data;
		if (typeof data !== "object" || data === null) continue;
		const dataRecord = data as Record<string, unknown>;

		const pathObj = dataRecord.path;
		if (typeof pathObj !== "object" || pathObj === null) continue;
		const path = getString(pathObj as Record<string, unknown>, "text");
		if (!path) continue;

		const lineNumber = getNumber(dataRecord, "line_number");
		if (lineNumber === undefined || !Number.isInteger(lineNumber)) continue;

		const linesObj = dataRecord.lines;
		if (typeof linesObj !== "object" || linesObj === null) continue;
		const lineText = getString(linesObj as Record<string, unknown>, "text");
		if (lineText === undefined) continue;

		const splitLines = splitEventLines(lineText);
		const kind: "match" | "context" = type === "match" ? "match" : "context";
		const lineMap = ensurePathLineMap(pathLineMap, path);

		for (let i = 0; i < splitLines.length; i++) {
			const currentLine = lineNumber + i;
			const existing = lineMap.get(currentLine);
			if (!existing || (existing.kind === "context" && kind === "match")) {
				lineMap.set(currentLine, { kind, text: splitLines[i] });
			}
		}

		if (kind === "match") {
			matchSpans.push({
				path,
				startLine: lineNumber,
				endLine: lineNumber + splitLines.length - 1,
			});
		}
	}

	const entries = matchSpans.map((span) => {
		const lineMap = pathLineMap.get(span.path);
		if (!lineMap) {
			return `${span.path}:${span.startLine}:`;
		}

		const fromLine = Math.max(1, span.startLine - beforeContext);
		const toLine = span.endLine + afterContext;
		const lines: string[] = [];

		for (let lineNumber = fromLine; lineNumber <= toLine; lineNumber++) {
			const record = lineMap.get(lineNumber);
			if (!record) continue;
			const separator = record.kind === "match" ? ":" : "-";
			lines.push(`${span.path}${separator}${lineNumber}${separator}${record.text}`);
		}

		return lines.join("\n");
	});

	return {
		entries,
		matchCount: matchSpans.length,
	};
}

function parseLineEntries(stdout: string): string[] {
	const normalized = normalizeTextOutput(stdout).trimEnd();
	if (!normalized) return [];
	return normalized.split("\n");
}

function applyPagination(
	entries: string[],
	offset: number,
	headLimit?: number,
): {
	pagedEntries: string[];
	totalAfterOffset: number;
	headLimitTruncated: boolean;
} {
	const start = Math.min(offset, entries.length);
	const afterOffset = entries.slice(start);
	if (headLimit === undefined) {
		return {
			pagedEntries: afterOffset,
			totalAfterOffset: afterOffset.length,
			headLimitTruncated: false,
		};
	}
	const pagedEntries = afterOffset.slice(0, headLimit);
	return {
		pagedEntries,
		totalAfterOffset: afterOffset.length,
		headLimitTruncated: afterOffset.length > headLimit,
	};
}

function joinContentEntries(entries: string[]): string {
	if (entries.length === 0) return "";
	if (entries.length === 1) return entries[0];
	return entries.join("\n--\n");
}

function buildRgArgs(params: RgInput, outputMode: OutputMode, searchPath: string, workspaceCwd: string): string[] {
	const args: string[] = ["--color=never"];
	if (params["-i"]) args.push("-i");
	if (params.type) args.push("--type", params.type);
	if (params.glob) args.push("--glob", params.glob);
	if (params.multiline) args.push("-U", "--multiline-dotall");
	const monopilotIgnorePath = resolveMonopilotIgnorePath(workspaceCwd);
	if (monopilotIgnorePath) args.push("--ignore-file", monopilotIgnorePath);

	if (outputMode === "files_with_matches") {
		args.push("--files-with-matches");
	} else if (outputMode === "count") {
		args.push("--count");
	} else {
		args.push("--json");
		const before = toNonNegativeInteger(params["-B"]);
		const after = toNonNegativeInteger(params["-A"]);
		const around = toNonNegativeInteger(params["-C"]);
		if (before !== undefined) args.push("-B", String(before));
		if (after !== undefined) args.push("-A", String(after));
		if (around !== undefined) args.push("-C", String(around));
	}

	args.push("--", params.pattern, searchPath);
	return args;
}

function runRipgrep(args: string[], cwd: string, signal?: AbortSignal): Promise<RgExecutionResult> {
	return new Promise((resolveResult, rejectResult) => {
		const child = spawn("rg", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let aborted = false;

		const onAbort = () => {
			aborted = true;
			if (!child.killed) child.kill();
		};

		if (signal) {
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		child.stdout?.on("data", (chunk: Buffer) => {
			stdoutChunks.push(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrChunks.push(chunk);
		});
		child.on("error", (error) => {
			if (signal) signal.removeEventListener("abort", onAbort);
			rejectResult(new Error(`Failed to run rg: ${error.message}`));
		});
		child.on("close", (code) => {
			if (signal) signal.removeEventListener("abort", onAbort);
			if (aborted) {
				rejectResult(new Error("Operation aborted"));
				return;
			}
			resolveResult({
				code,
				stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
				stderr: Buffer.concat(stderrChunks).toString("utf-8"),
			});
		});
	});
}

function compactForCommandArg(value: string, maxLength: number): string {
	const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\\n").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function shellQuoteArg(value: string): string {
	if (value.length === 0) return "''";
	if (/^[A-Za-z0-9_./:=,+-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function getCollapsedResultText(text: string, expanded: boolean): { output: string; remaining: number } {
	if (text.length === 0) {
		return { output: text, remaining: 0 };
	}

	const lines = text.split("\n");
	// Use 20 lines as the standard collapse threshold
	const MAX_COLLAPSED_RESULT_LINES = 20;

	if (expanded || lines.length <= MAX_COLLAPSED_RESULT_LINES) {
		return { output: text, remaining: 0 };
	}

	return {
		output: lines.slice(0, MAX_COLLAPSED_RESULT_LINES).join("\n"),
		remaining: lines.length - MAX_COLLAPSED_RESULT_LINES,
	};
}

export const __test__ = {
	applyPagination,
	buildRgArgs,
	parseContentEvents,
	resolveMonopilotIgnorePath,
};

export default function (pi: ExtensionAPI) {
	// System prompt injection is handled centrally by system-prompt extension.

	pi.registerTool({
		name: "rg",
		label: "rg",
		description: DESCRIPTION,
		parameters: rgSchema,
		renderCall(args, theme) {
			const params = args as RgInput;
			const outputMode: OutputMode = params.output_mode ?? "content";

			const commandArgs: string[] = ["rg", "--color=never"];
			if (params["-i"]) commandArgs.push("-i");
			if (params.type) commandArgs.push("--type", params.type);
			if (params.glob) commandArgs.push("--glob", params.glob);
			if (params.multiline) commandArgs.push("-U", "--multiline-dotall");

			if (outputMode === "files_with_matches") {
				commandArgs.push("--files-with-matches");
			} else if (outputMode === "count") {
				commandArgs.push("--count");
			} else {
				commandArgs.push("--json");
				const before = toNonNegativeInteger(params["-B"]);
				const after = toNonNegativeInteger(params["-A"]);
				const around = toNonNegativeInteger(params["-C"]);
				if (before !== undefined) commandArgs.push("-B", String(before));
				if (after !== undefined) commandArgs.push("-A", String(after));
				if (around !== undefined) commandArgs.push("-C", String(around));
			}

			const pattern = compactForCommandArg(params.pattern ?? "", 120);
			const pathArg = compactForCommandArg(params.path?.trim() ? params.path : ".", 100);
			commandArgs.push("--", pattern, pathArg);

			const commandText = commandArgs.slice(1).map(shellQuoteArg).join(" ");

			let text = theme.fg("toolTitle", theme.bold("rg"));
			text += ` ${theme.fg("toolOutput", commandText)}`;

			const toolPagination: string[] = [];
			if (params.offset !== undefined) toolPagination.push(`offset=${params.offset}`);
			if (params.head_limit !== undefined) toolPagination.push(`head_limit=${params.head_limit}`);
			if (toolPagination.length > 0) {
				text += ` ${theme.fg("muted", toolPagination.join(" "))}`;
			}

			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("muted", "Searching..."), 0, 0);
			}

			const textBlock = result.content.find((entry): entry is any => entry.type === "text" && typeof (entry as any).text === "string");
			if (!textBlock || typeof textBlock.text !== "string") {
				return new Text(theme.fg("error", "No text result returned."), 0, 0);
			}

			const { output, remaining } = getCollapsedResultText(textBlock.text, expanded);
			const isErrorResult = (result as any).isError === true || (result.details as any)?.is_error === true;

			let text = output
				.split("\n")
				.map((line) => (isErrorResult ? theme.fg("error", line) : theme.fg("toolOutput", line)))
				.join("\n");

			if (!expanded && remaining > 0) {
				text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("expandTools", "to expand")})`;
			}

			return new Text(text, 0, 0);
		},
		async execute(_toolCallId, params: RgInput, signal, _onUpdate, ctx) {
			const outputMode: OutputMode = params.output_mode ?? "content";
			const offset = toNonNegativeInteger(params.offset) ?? 0;
			const headLimit = toNonNegativeInteger(params.head_limit);
			const searchPath = resolveSearchPath(params.path, ctx.cwd);

			const args = buildRgArgs(params, outputMode, searchPath, ctx.cwd);
			const result = await runRipgrep(args, ctx.cwd, signal);

			if (result.code !== 0 && result.code !== 1) {
				const errorMessage = result.stderr.trim() || `rg exited with code ${result.code ?? "unknown"}`;
				throw new Error(errorMessage);
			}

			let entries: string[];
			let outputText: string;
			if (outputMode === "content") {
				const around = toNonNegativeInteger(params["-C"]);
				const before = around ?? toNonNegativeInteger(params["-B"]) ?? 0;
				const after = around ?? toNonNegativeInteger(params["-A"]) ?? 0;
				const parsed = parseContentEvents(result.stdout, before, after);
				const pagination = applyPagination(parsed.entries, offset, headLimit);
				entries = pagination.pagedEntries;
				outputText = joinContentEntries(pagination.pagedEntries);

				if (entries.length === 0) {
					const noMatchText =
						parsed.matchCount === 0 || pagination.totalAfterOffset === 0
							? "No matches found"
							: "No matches shown after pagination. Increase head_limit or reduce offset.";
					return {
						content: [{ type: "text", text: noMatchText }],
						details: {
							output_mode: outputMode,
							search_path: searchPath,
							offset,
							head_limit: headLimit,
							returned_entries: 0,
							total_entries_after_offset: pagination.totalAfterOffset,
							head_limit_truncated: pagination.headLimitTruncated || undefined,
						} satisfies RgToolDetails,
					};
				}

				const truncation = truncateHead(outputText, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
				let finalText = truncation.content;
				if (truncation.truncated) {
					const notice = `[Output truncated to ${formatSize(DEFAULT_MAX_BYTES)} / ${DEFAULT_MAX_LINES} lines.]`;
					finalText = `${finalText}\n\n${notice}`;
				}

				return {
					content: [{ type: "text", text: finalText }],
					details: {
						output_mode: outputMode,
						search_path: searchPath,
						offset,
						head_limit: headLimit,
						returned_entries: pagination.pagedEntries.length,
						total_entries_after_offset: pagination.totalAfterOffset,
						head_limit_truncated: pagination.headLimitTruncated || undefined,
						content_truncated: truncation.truncated || undefined,
					} satisfies RgToolDetails,
				};
			}

			const lineEntries = parseLineEntries(result.stdout);
			const pagination = applyPagination(lineEntries, offset, headLimit);
			entries = pagination.pagedEntries;
			outputText = entries.join("\n");

			if (entries.length === 0) {
				return {
					content: [{ type: "text", text: "No matches found" }],
					details: {
						output_mode: outputMode,
						search_path: searchPath,
						offset,
						head_limit: headLimit,
						returned_entries: 0,
						total_entries_after_offset: pagination.totalAfterOffset,
						head_limit_truncated: pagination.headLimitTruncated || undefined,
					} satisfies RgToolDetails,
				};
			}

			const truncation = truncateHead(outputText, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
			let finalText = truncation.content;
			if (truncation.truncated) {
				const notice = `[Output truncated to ${formatSize(DEFAULT_MAX_BYTES)} / ${DEFAULT_MAX_LINES} lines.]`;
				finalText = `${finalText}\n\n${notice}`;
			}

			return {
				content: [{ type: "text", text: finalText }],
				details: {
					output_mode: outputMode,
					search_path: searchPath,
					offset,
					head_limit: headLimit,
					returned_entries: pagination.pagedEntries.length,
					total_entries_after_offset: pagination.totalAfterOffset,
					head_limit_truncated: pagination.headLimitTruncated || undefined,
					content_truncated: truncation.truncated || undefined,
				} satisfies RgToolDetails,
			};
		},
	});
}
