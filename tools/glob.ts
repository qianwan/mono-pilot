import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	formatSize,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { globSync } from "glob";

const DESCRIPTION = `
Tool to search for files matching a glob pattern

- Works fast with codebases of any size
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- You have the capability to call multiple tools in a single response. It is always better to speculatively perform multiple searches that are potentially useful as a batch.
`.trim()

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
