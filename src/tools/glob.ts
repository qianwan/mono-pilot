import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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
import { globSync } from "glob";

const DESCRIPTION = `
Tool to search for files matching a glob pattern

- Works fast with codebases of any size
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- You have the capability to call multiple tools in a single response. It is always better to speculatively perform multiple searches that are potentially useful as a batch.
`.trim()

const MAX_RENDER_PATH_CHARS = 120;
const MAX_RENDER_PATTERN_CHARS = 160;


const globSchema = Type.Object({
	target_directory: Type.Optional(
		Type.String({
			description:
				"Absolute path to directory to search for files in. If not provided, defaults to mono-pilot workspace root.",
		}),
	),
	glob_pattern: Type.String({
		description:
			`The glob pattern to match files against.
Patterns not starting with "**/" are automatically prepended with "**/" to enable recursive searching.

Examples:
- "*.js" (becomes "**/*.js") - find all .js files
- "**/node_modules/**" - find all node_modules directories
- "**/test/**/test_*.ts" - find all test_*.ts files in any test directory`,
	}),
});

type GlobInput = Static<typeof globSchema>;

interface MatchWithMtime {
	relativePath: string;
	mtimeMs: number;
}

interface GlobDetails {
	target_directory: string;
	glob_pattern: string;
	normalized_pattern: string;
	total_matches: number;
	returned_matches: number;
	content_truncated?: boolean;
}

function compactForCommandArg(value: string, maxLength: number): string {
	const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\\n").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function shellQuoteArg(value: string): string {
	if (value.length === 0) return "''";
	if (/^[A-Za-z0-9_./:=,+-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `"'"'`)}'`;
}


function normalizeGlobPattern(pattern: string): string {
	const trimmed = pattern.trim();
	if (trimmed.length === 0) {
		throw new Error("glob_pattern cannot be empty");
	}
	if (trimmed.startsWith("**/")) return trimmed;
	return `**/${trimmed}`;
}

function resolveTargetDirectory(targetDirectory: string | undefined, workspaceCwd: string): string {
	if (!targetDirectory || targetDirectory.trim().length === 0) {
		return workspaceCwd;
	}
	if (!isAbsolute(targetDirectory)) {
		throw new Error(`target_directory must be an absolute path: ${targetDirectory}`);
	}
	if (!existsSync(targetDirectory)) {
		throw new Error(`target_directory does not exist: ${targetDirectory}`);
	}
	const stats = statSync(targetDirectory);
	if (!stats.isDirectory()) {
		throw new Error(`target_directory is not a directory: ${targetDirectory}`);
	}
	return targetDirectory;
}

function toPosixPath(pathText: string): string {
	return pathText.replace(/\\/g, "/");
}

function collectMatchesSortedByMtime(targetDirectory: string, normalizedPattern: string): MatchWithMtime[] {
	const relativeMatches = globSync(normalizedPattern, {
		cwd: targetDirectory,
		dot: true,
		nodir: false,
		ignore: ["**/node_modules/**", "**/.git/**"],
	});

	const entries: MatchWithMtime[] = [];
	for (const relativePath of relativeMatches) {
		const absolutePath = join(targetDirectory, relativePath);
		try {
			const stats = statSync(absolutePath);
			entries.push({
				relativePath: toPosixPath(relativePath),
				mtimeMs: stats.mtimeMs,
			});
		} catch {
			// Skip entries that disappear between globbing and stat.
		}
	}

	entries.sort((a, b) => b.mtimeMs - a.mtimeMs || a.relativePath.localeCompare(b.relativePath));
	return entries;
}

export default function (pi: ExtensionAPI) {
	// System prompt injection is handled centrally by system-prompt extension.

	pi.registerTool({
		name: "Glob",
		label: "Glob",
		description: DESCRIPTION,
		parameters: globSchema,
		renderCall(args, theme) {
			const input = args as Partial<GlobInput>;
			const pattern =
				typeof input.glob_pattern === "string" && input.glob_pattern.trim().length > 0
					? compactForCommandArg(input.glob_pattern, MAX_RENDER_PATTERN_CHARS)
					: "(missing glob_pattern)";
			const targetDirectory =
				typeof input.target_directory === "string" && input.target_directory.trim().length > 0
					? compactForCommandArg(input.target_directory, MAX_RENDER_PATH_CHARS)
					: undefined;

			const commandArgs = [pattern];
			if (targetDirectory) commandArgs.push("--target-directory", targetDirectory);
			const commandText = commandArgs.map(shellQuoteArg).join(" ");

			let text = theme.fg("toolTitle", theme.bold("Glob"));
			text += ` ${theme.fg("toolOutput", commandText)}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("muted", "Searching..."), 0, 0);
			}

			const textBlock = result.content.find(
				(entry): entry is { type: "text"; text: string } => entry.type === "text" && typeof entry.text === "string",
			);
			if (!textBlock || typeof textBlock.text !== "string") {
				return new Text(theme.fg("error", "No text result returned."), 0, 0);
			}

			const fullText = textBlock.text;
			const details = result.details as GlobDetails | undefined;
			const fileCount = details?.returned_matches ?? fullText.split("\n").length;

			if (!expanded) {
				const summary = `${fileCount} files (click or ${keyHint("expandTools", "to expand")})`;
				return new Text(theme.fg("muted", summary), 0, 0);
			}

			let text = fullText
				.split("\n")
				.map((line: string) => theme.fg("toolOutput", line))
				.join("\n");
			text += theme.fg("muted", `\n(click or ${keyHint("expandTools", "to collapse")})`);
			return new Text(text, 0, 0);
		},
		async execute(_toolCallId, params: GlobInput, _signal, _onUpdate, ctx) {
			const targetDirectory = resolveTargetDirectory(params.target_directory, ctx.cwd);
			const normalizedPattern = normalizeGlobPattern(params.glob_pattern);
			const matches = collectMatchesSortedByMtime(targetDirectory, normalizedPattern);

			if (matches.length === 0) {
				return {
					content: [{ type: "text", text: "No files found matching pattern" }],
					details: {
						target_directory: targetDirectory,
						glob_pattern: params.glob_pattern,
						normalized_pattern: normalizedPattern,
						total_matches: 0,
						returned_matches: 0,
					} satisfies GlobDetails,
				};
			}

			const rawOutput = matches.map((entry) => entry.relativePath).join("\n");
			const truncation = truncateHead(rawOutput, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
			let outputText = truncation.content;
			if (truncation.truncated) {
				outputText += `\n\n[Output truncated to ${formatSize(DEFAULT_MAX_BYTES)} / ${DEFAULT_MAX_LINES} lines.]`;
			}

			const returnedMatches =
				truncation.truncated && truncation.outputLines > 0
					? Math.min(truncation.outputLines, matches.length)
					: matches.length;

			return {
				content: [{ type: "text", text: outputText }],
				details: {
					target_directory: targetDirectory,
					glob_pattern: params.glob_pattern,
					normalized_pattern: normalizedPattern,
					total_matches: matches.length,
					returned_matches: returnedMatches,
					content_truncated: truncation.truncated || undefined,
				} satisfies GlobDetails,
			};
		},
	});
}
