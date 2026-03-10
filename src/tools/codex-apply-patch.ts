import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keyHint, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const CHANGE_CONTEXT_MARKER = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER = "@@";

const DESCRIPTION = readFileSync(
	fileURLToPath(new URL("./codex-apply-patch-description.md", import.meta.url)),
	"utf-8",
).trim();

const codexApplyPatchSchema = Type.Object({
	patch: Type.String({
		description:
			"Patch document in codex apply_patch format. Supports multiple file hunks with Add/Delete/Update.",
	}),
});

type CodexApplyPatchInput = Static<typeof codexApplyPatchSchema>;

class ParseError extends Error {
	readonly lineNumber?: number;

	constructor(message: string, lineNumber?: number) {
		super(message);
		this.name = "ParseError";
		this.lineNumber = lineNumber;
	}
}

interface AddFileHunk {
	type: "add";
	path: string;
	contents: string;
}

interface DeleteFileHunk {
	type: "delete";
	path: string;
}

interface UpdateFileChunk {
	changeContext?: string;
	oldLines: string[];
	newLines: string[];
	isEndOfFile: boolean;
}

interface UpdateFileHunk {
	type: "update";
	path: string;
	movePath?: string;
	chunks: UpdateFileChunk[];
}

type Hunk = AddFileHunk | DeleteFileHunk | UpdateFileHunk;

interface ParsedPatch {
	patch: string;
	hunks: Hunk[];
}

interface CodexApplyPatchDetails {
	cwd: string;
	patch_line_count: number;
	hunk_count: number;
	added: string[];
	modified: string[];
	deleted: string[];
	patch_text: string;
}

function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function countPatchLines(patch: string): number {
	const normalized = normalizeLineEndings(patch).trim();
	if (normalized.length === 0) return 0;
	return normalized.split("\n").length;
}

function ensureNotAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
}

function hasStrictBoundaries(lines: string[]): boolean {
	if (lines.length < 2) return false;
	return lines[0]?.trim() === BEGIN_PATCH_MARKER && lines[lines.length - 1]?.trim() === END_PATCH_MARKER;
}

function parsePatchLinesWithLenientHeredoc(lines: string[]): string[] {
	if (hasStrictBoundaries(lines)) {
		return lines;
	}

	const first = lines[0]?.trim();
	const last = lines[lines.length - 1]?.trim();
	const isHeredoc = (first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') && typeof last === "string" && last.endsWith("EOF");
	if (!isHeredoc || lines.length < 4) {
		if (lines[0]?.trim() !== BEGIN_PATCH_MARKER) {
			throw new ParseError("The first line of the patch must be '*** Begin Patch'");
		}
		throw new ParseError("The last line of the patch must be '*** End Patch'");
	}

	const innerLines = lines.slice(1, -1);
	if (!hasStrictBoundaries(innerLines)) {
		if (innerLines[0]?.trim() !== BEGIN_PATCH_MARKER) {
			throw new ParseError("The first line of the patch must be '*** Begin Patch'");
		}
		throw new ParseError("The last line of the patch must be '*** End Patch'");
	}

	return innerLines;
}

function parsePatch(patch: string): ParsedPatch {
	const normalized = normalizeLineEndings(patch);
	const rawLines = normalized.trim().split("\n");
	const lines = parsePatchLinesWithLenientHeredoc(rawLines);

	const hunks: Hunk[] = [];
	let lineNumber = 2;
	let remaining = lines.slice(1, -1);

	while (remaining.length > 0) {
		const parsed = parseOneHunk(remaining, lineNumber);
		hunks.push(parsed.hunk);
		lineNumber += parsed.consumedLines;
		remaining = remaining.slice(parsed.consumedLines);
	}

	return {
		patch: lines.join("\n"),
		hunks,
	};
}

function parseOneHunk(lines: string[], lineNumber: number): { hunk: Hunk; consumedLines: number } {
	const firstLine = lines[0]?.trim() ?? "";

	if (firstLine.startsWith(ADD_FILE_MARKER)) {
		const path = firstLine.slice(ADD_FILE_MARKER.length);
		let contents = "";
		let consumed = 1;
		for (const addLine of lines.slice(1)) {
			if (!addLine.startsWith("+")) break;
			contents += `${addLine.slice(1)}\n`;
			consumed += 1;
		}
		return {
			hunk: { type: "add", path, contents },
			consumedLines: consumed,
		};
	}

	if (firstLine.startsWith(DELETE_FILE_MARKER)) {
		const path = firstLine.slice(DELETE_FILE_MARKER.length);
		return {
			hunk: { type: "delete", path },
			consumedLines: 1,
		};
	}

	if (firstLine.startsWith(UPDATE_FILE_MARKER)) {
		const path = firstLine.slice(UPDATE_FILE_MARKER.length);
		let consumed = 1;
		let remaining = lines.slice(1);

		let movePath: string | undefined;
		const moveLine = remaining[0];
		if (typeof moveLine === "string" && moveLine.startsWith(MOVE_TO_MARKER)) {
			movePath = moveLine.slice(MOVE_TO_MARKER.length);
			consumed += 1;
			remaining = remaining.slice(1);
		}

		const chunks: UpdateFileChunk[] = [];
		while (remaining.length > 0) {
			if (remaining[0]?.trim().length === 0) {
				consumed += 1;
				remaining = remaining.slice(1);
				continue;
			}
			if (remaining[0]?.startsWith("***")) {
				break;
			}

			const chunk = parseUpdateFileChunk(remaining, lineNumber + consumed, chunks.length === 0);
			chunks.push(chunk.chunk);
			consumed += chunk.consumedLines;
			remaining = remaining.slice(chunk.consumedLines);
		}

		if (chunks.length === 0) {
			throw new ParseError(`Update file hunk for path '${path}' is empty`, lineNumber);
		}

		return {
			hunk: { type: "update", path, movePath, chunks },
			consumedLines: consumed,
		};
	}

	throw new ParseError(
		`'${firstLine}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
		lineNumber,
	);
}

function parseUpdateFileChunk(
	lines: string[],
	lineNumber: number,
	allowMissingContext: boolean,
): { chunk: UpdateFileChunk; consumedLines: number } {
	if (lines.length === 0) {
		throw new ParseError("Update hunk does not contain any lines", lineNumber);
	}

	let changeContext: string | undefined;
	let startIndex = 0;
	if (lines[0] === EMPTY_CHANGE_CONTEXT_MARKER) {
		startIndex = 1;
	} else if (lines[0]?.startsWith(CHANGE_CONTEXT_MARKER)) {
		changeContext = lines[0].slice(CHANGE_CONTEXT_MARKER.length);
		startIndex = 1;
	} else if (!allowMissingContext) {
		throw new ParseError(
			`Expected update hunk to start with a @@ context marker, got: '${lines[0] ?? ""}'`,
			lineNumber,
		);
	}

	if (startIndex >= lines.length) {
		throw new ParseError("Update hunk does not contain any lines", lineNumber + 1);
	}

	const chunk: UpdateFileChunk = {
		changeContext,
		oldLines: [],
		newLines: [],
		isEndOfFile: false,
	};

	let parsedLines = 0;
	for (const line of lines.slice(startIndex)) {
		if (line === EOF_MARKER) {
			if (parsedLines === 0) {
				throw new ParseError("Update hunk does not contain any lines", lineNumber + 1);
			}
			chunk.isEndOfFile = true;
			parsedLines += 1;
			break;
		}

		const marker = line[0];
		if (marker === undefined) {
			chunk.oldLines.push("");
			chunk.newLines.push("");
			parsedLines += 1;
			continue;
		}

		if (marker === " ") {
			const text = line.slice(1);
			chunk.oldLines.push(text);
			chunk.newLines.push(text);
			parsedLines += 1;
			continue;
		}

		if (marker === "+") {
			chunk.newLines.push(line.slice(1));
			parsedLines += 1;
			continue;
		}

		if (marker === "-") {
			chunk.oldLines.push(line.slice(1));
			parsedLines += 1;
			continue;
		}

		if (parsedLines === 0) {
			throw new ParseError(
				`Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
				lineNumber + 1,
			);
		}

		break;
	}

	return {
		chunk,
		consumedLines: parsedLines + startIndex,
	};
}

function resolveRelativePatchPath(cwd: string, patchPath: string): string {
	const trimmed = patchPath.trim();
	if (trimmed.length === 0) {
		throw new Error("Patch path cannot be empty.");
	}
	if (isAbsolute(trimmed)) {
		throw new Error(`Patch path must be relative: ${patchPath}`);
	}
	return resolve(cwd, trimmed);
}

function seekSequence(lines: string[], pattern: string[], start: number, eof: boolean): number | undefined {
	if (pattern.length === 0) {
		return start;
	}
	if (pattern.length > lines.length) {
		return undefined;
	}

	const searchStart = eof && lines.length >= pattern.length ? lines.length - pattern.length : start;
	const end = lines.length - pattern.length;

	for (let i = searchStart; i <= end; i++) {
		let match = true;
		for (let j = 0; j < pattern.length; j++) {
			if (lines[i + j] !== pattern[j]) {
				match = false;
				break;
			}
		}
		if (match) return i;
	}

	for (let i = searchStart; i <= end; i++) {
		let match = true;
		for (let j = 0; j < pattern.length; j++) {
			if (lines[i + j]?.trimEnd() !== pattern[j]?.trimEnd()) {
				match = false;
				break;
			}
		}
		if (match) return i;
	}

	for (let i = searchStart; i <= end; i++) {
		let match = true;
		for (let j = 0; j < pattern.length; j++) {
			if (lines[i + j]?.trim() !== pattern[j]?.trim()) {
				match = false;
				break;
			}
		}
		if (match) return i;
	}

	const normalizeForFuzzyMatch = (value: string): string => {
		const source = value.trim();
		let out = "";
		for (const char of source) {
			switch (char) {
				case "\u2010":
				case "\u2011":
				case "\u2012":
				case "\u2013":
				case "\u2014":
				case "\u2015":
				case "\u2212":
					out += "-";
					break;
				case "\u2018":
				case "\u2019":
				case "\u201A":
				case "\u201B":
					out += "'";
					break;
				case "\u201C":
				case "\u201D":
				case "\u201E":
				case "\u201F":
					out += '"';
					break;
				case "\u00A0":
				case "\u2002":
				case "\u2003":
				case "\u2004":
				case "\u2005":
				case "\u2006":
				case "\u2007":
				case "\u2008":
				case "\u2009":
				case "\u200A":
				case "\u202F":
				case "\u205F":
				case "\u3000":
					out += " ";
					break;
				default:
					out += char;
			}
		}
		return out;
	};

	for (let i = searchStart; i <= end; i++) {
		let match = true;
		for (let j = 0; j < pattern.length; j++) {
			if (normalizeForFuzzyMatch(lines[i + j] ?? "") !== normalizeForFuzzyMatch(pattern[j] ?? "")) {
				match = false;
				break;
			}
		}
		if (match) return i;
	}

	return undefined;
}

function applyReplacements(lines: string[], replacements: Array<[number, number, string[]]>): string[] {
	for (const [startIndex, oldLength, newSegment] of replacements.slice().reverse()) {
		lines.splice(startIndex, oldLength, ...newSegment);
	}
	return lines;
}

function computeReplacements(path: string, originalLines: string[], chunks: UpdateFileChunk[]): Array<[number, number, string[]]> {
	const replacements: Array<[number, number, string[]]> = [];
	let lineIndex = 0;

	for (const chunk of chunks) {
		if (chunk.changeContext) {
			const contextIndex = seekSequence(originalLines, [chunk.changeContext], lineIndex, false);
			if (contextIndex === undefined) {
				throw new Error(`Failed to find context '${chunk.changeContext}' in ${path}`);
			}
			lineIndex = contextIndex + 1;
		}

		if (chunk.oldLines.length === 0) {
			const insertionIndex = originalLines.at(-1) === "" ? originalLines.length - 1 : originalLines.length;
			replacements.push([insertionIndex, 0, [...chunk.newLines]]);
			continue;
		}

		let pattern = chunk.oldLines;
		let nextSegment = chunk.newLines;
		let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);

		if (found === undefined && pattern.at(-1) === "") {
			pattern = pattern.slice(0, -1);
			if (nextSegment.at(-1) === "") {
				nextSegment = nextSegment.slice(0, -1);
			}
			found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
		}

		if (found === undefined) {
			throw new Error(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`);
		}

		replacements.push([found, pattern.length, [...nextSegment]]);
		lineIndex = found + pattern.length;
	}

	replacements.sort((a, b) => a[0] - b[0]);
	return replacements;
}

async function deriveUpdatedFileContents(path: string, chunks: UpdateFileChunk[]): Promise<string> {
	const originalContents = await readFile(path, "utf-8");
	const originalLines = normalizeLineEndings(originalContents).split("\n");
	if (originalLines.at(-1) === "") {
		originalLines.pop();
	}

	const replacements = computeReplacements(path, originalLines, chunks);
	const newLines = applyReplacements([...originalLines], replacements);
	if (newLines.at(-1) !== "") {
		newLines.push("");
	}
	return newLines.join("\n");
}

function formatDisplayPath(cwd: string, absolutePath: string): string {
	const rel = relative(cwd, absolutePath);
	if (rel.length === 0) return ".";
	if (!rel.startsWith("..") && !isAbsolute(rel)) return rel;
	return absolutePath;
}

function buildSummary(added: string[], modified: string[], deleted: string[]): string {
	const lines = ["Success. Updated the following files:"];
	for (const path of added) lines.push(`A ${path}`);
	for (const path of modified) lines.push(`M ${path}`);
	for (const path of deleted) lines.push(`D ${path}`);
	return `${lines.join("\n")}\n`;
}

function buildCallSummary(patch: string): string {
	const lineCount = countPatchLines(patch);
	const normalized = normalizeLineEndings(patch);
	const firstOp = normalized
		.split("\n")
		.find((line) => line.startsWith(ADD_FILE_MARKER) || line.startsWith(DELETE_FILE_MARKER) || line.startsWith(UPDATE_FILE_MARKER));
	if (!firstOp) return `${lineCount} line(s)`;
	if (firstOp.startsWith(ADD_FILE_MARKER)) {
		return `add ${firstOp.slice(ADD_FILE_MARKER.length).trim()} (${lineCount} line(s))`;
	}
	if (firstOp.startsWith(DELETE_FILE_MARKER)) {
		return `delete ${firstOp.slice(DELETE_FILE_MARKER.length).trim()} (${lineCount} line(s))`;
	}
	return `update ${firstOp.slice(UPDATE_FILE_MARKER.length).trim()} (${lineCount} line(s))`;
}

async function applyCodexPatchToFilesystem(options: {
	patchText: string;
	cwd: string;
	signal?: AbortSignal;
}): Promise<{ summary: string; details: CodexApplyPatchDetails }> {
	const parsed = parsePatch(options.patchText);
	if (parsed.hunks.length === 0) {
		throw new Error("No files were modified.");
	}

	const added: string[] = [];
	const modified: string[] = [];
	const deleted: string[] = [];

	for (const hunk of parsed.hunks) {
		ensureNotAborted(options.signal);
		if (hunk.type === "add") {
			const path = resolveRelativePatchPath(options.cwd, hunk.path);
			const parent = dirname(path);
			if (parent && parent !== ".") {
				await mkdir(parent, { recursive: true });
			}
			await writeFile(path, hunk.contents, "utf-8");
			added.push(formatDisplayPath(options.cwd, path));
			continue;
		}

		if (hunk.type === "delete") {
			const path = resolveRelativePatchPath(options.cwd, hunk.path);
			await rm(path);
			deleted.push(formatDisplayPath(options.cwd, path));
			continue;
		}

		const sourcePath = resolveRelativePatchPath(options.cwd, hunk.path);
		const updatedContent = await deriveUpdatedFileContents(sourcePath, hunk.chunks);

		if (hunk.movePath) {
			const destinationPath = resolveRelativePatchPath(options.cwd, hunk.movePath);
			const parent = dirname(destinationPath);
			if (parent && parent !== ".") {
				await mkdir(parent, { recursive: true });
			}
			await writeFile(destinationPath, updatedContent, "utf-8");
			await rm(sourcePath);
			modified.push(formatDisplayPath(options.cwd, destinationPath));
		} else {
			await writeFile(sourcePath, updatedContent, "utf-8");
			modified.push(formatDisplayPath(options.cwd, sourcePath));
		}
	}

	const details: CodexApplyPatchDetails = {
		cwd: options.cwd,
		patch_line_count: countPatchLines(parsed.patch),
		hunk_count: parsed.hunks.length,
		added,
		modified,
		deleted,
		patch_text: parsed.patch,
	};

	return {
		summary: buildSummary(added, modified, deleted),
		details,
	};
}

export default function codexApplyPatchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "CodexApplyPatch",
		label: "Codex Apply Patch",
		description: DESCRIPTION,
		parameters: codexApplyPatchSchema,
		renderCall(args, theme) {
			const input = args as Partial<CodexApplyPatchInput>;
			const summary = typeof input.patch === "string" ? buildCallSummary(input.patch) : "(missing patch)";
			let text = theme.fg("toolTitle", theme.bold("CodexApplyPatch"));
			text += ` ${theme.fg("toolOutput", summary)}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("muted", "Applying codex patch..."), 0, 0);
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
				return new Text(theme.fg("muted", `${lineCount} lines (click or ${keyHint("expandTools", "to expand")})`), 0, 0);
			}

			const details = result.details as CodexApplyPatchDetails | undefined;
			let text = fullText
				.split("\n")
				.map((line) => theme.fg("toolOutput", line))
				.join("\n");

			if (details?.patch_text) {
				const patchLines = details.patch_text
					.split("\n")
					.map((line) => theme.fg("toolOutput", line))
					.join("\n");
				text += `\n${theme.fg("toolOutput", "patch:")}\n${patchLines}`;
			}

			text += theme.fg("muted", `\n(click or ${keyHint("expandTools", "to collapse")})`);
			return new Text(text, 0, 0);
		},
		async execute(_toolCallId, params: CodexApplyPatchInput, signal, _onUpdate, ctx) {
			try {
				const { summary, details } = await applyCodexPatchToFilesystem({
					patchText: params.patch,
					cwd: ctx.cwd,
					signal,
				});
				return {
					content: [{ type: "text" as const, text: summary }],
					details,
				};
			} catch (error) {
				if (error instanceof ParseError) {
					if (error.lineNumber !== undefined) {
						throw new Error(`Invalid patch hunk on line ${error.lineNumber}: ${error.message}`);
					}
					throw new Error(`Invalid patch: ${error.message}`);
				}
				throw error;
			}
		},
	});
}