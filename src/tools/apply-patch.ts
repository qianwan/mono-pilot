import { readFileSync, existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createEditTool, createWriteTool, keyHint } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { loadSftpTargets, syncSftpFile, type SftpSyncDetails } from "../extensions/sftp.js";

const BEGIN_PATCH = "*** Begin Patch";
const END_PATCH = "*** End Patch";
const ADD_FILE = "*** Add File: ";
const UPDATE_FILE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";
const END_OF_FILE = "*** End of File";
const MAX_RENDER_SUMMARY_PATH_CHARS = 96;
const MAX_RENDER_FIRST_CHANGED_LINES = 12;

const DESCRIPTION = readFileSync(fileURLToPath(new URL("./apply-patch-description.md", import.meta.url)), "utf-8").trim();

const applyPatchSchema = Type.Object({
	patch: Type.String({
		description:
			"Single-file patch document in ApplyPatch format. Must start with *** Begin Patch and end with *** End Patch.",
	}),
});

type ApplyPatchInput = Static<typeof applyPatchSchema>;

interface AddFileOperation {
	kind: "add";
	path: string;
	lines: string[];
}

interface UpdateHunk {
	headers: string[];
	lines: string[];
	lineHint?: LineHint;
}

interface UpdateFileOperation {
	kind: "update";
	path: string;
	moveTo?: string;
	hunks: UpdateHunk[];
}

type PatchOperation = AddFileOperation | UpdateFileOperation;

interface LineHint {
	startLine?: number;
	endLine?: number;
}

interface ParseResult {
	operation: PatchOperation;
}

export interface ApplyPatchDetails {
	operation: "add" | "update";
	path: string;
	moveTo?: string;
	hunkCount?: number;
	appliedHunks?: number;
	noopHunks?: number;
	firstChangedLines?: number[];
	bytesWritten?: number;
	patchLineCount?: number;
	patchText?: string;
	sftp?: SftpSyncDetails;
}

function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function getNormalizedPatchLines(patch: string): string[] {
	const normalized = normalizeLineEndings(patch).trimEnd();
	if (!normalized) return [];
	return normalized.split("\n");
}

function compactForSummary(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function buildPatchCallSummary(patch: string): string {
	const lines = getNormalizedPatchLines(patch);
	if (lines.length === 0) return "(empty patch)";

	const lineCountText = `${lines.length} line(s)`;
	const operationLine = lines.find((line) => isFileHeader(line));
	if (!operationLine) return lineCountText;

	if (operationLine.startsWith(ADD_FILE)) {
		const path = compactForSummary(operationLine.slice(ADD_FILE.length).trim() || "(missing path)", MAX_RENDER_SUMMARY_PATH_CHARS);
		return `add ${path} (${lineCountText})`;
	}

	const path = compactForSummary(operationLine.slice(UPDATE_FILE.length).trim() || "(missing path)", MAX_RENDER_SUMMARY_PATH_CHARS);
	return `update ${path} (${lineCountText})`;
}

function getResultSummaryText(content: Array<{ type: string; text?: string }>): string {
	const textBlock = content.find((entry) => entry.type === "text" && typeof entry.text === "string");
	if (!textBlock || typeof textBlock.text !== "string") {
		return "Patch applied.";
	}
	const summary = textBlock.text.trim();
	return summary.length > 0 ? summary : "Patch applied.";
}

function formatFirstChangedLines(firstChangedLines: number[] | undefined): string | undefined {
	if (!Array.isArray(firstChangedLines) || firstChangedLines.length === 0) return undefined;
	const validLines = firstChangedLines.filter((line): line is number => Number.isInteger(line));
	if (validLines.length === 0) return undefined;

	const shownLines = validLines.slice(0, MAX_RENDER_FIRST_CHANGED_LINES);
	const more = validLines.length - shownLines.length;
	const base = shownLines.join(", ");
	return more > 0 ? `${base} (+${more} more)` : base;
}

function buildRenderDetailLines(details: ApplyPatchDetails | undefined): string[] {
	if (!details) return [];

	const lines: string[] = [];
	if (details.patchLineCount !== undefined) {
		lines.push(`input patch: ${details.patchLineCount} line(s)`);
	}

	if (details.operation === "add") {
		if (details.bytesWritten !== undefined) {
			lines.push(`bytes written: ${details.bytesWritten}`);
		}
	} else {
		if (details.appliedHunks !== undefined && details.hunkCount !== undefined) {
			lines.push(`hunks applied: ${details.appliedHunks}/${details.hunkCount}`);
		}
		if (details.noopHunks !== undefined && details.noopHunks > 0) {
			lines.push(`no-op hunks: ${details.noopHunks}`);
		}
		const firstChanged = formatFirstChangedLines(details.firstChangedLines);
		if (firstChanged) {
			lines.push(`first changed lines: ${firstChanged}`);
		}
	}

	if (details.moveTo) {
		lines.push(`moved to: ${details.moveTo}`);
	}

	if (details.patchText !== undefined) {
		lines.push("patch:");
		lines.push(details.patchText.length > 0 ? details.patchText : "(empty patch)");
	}

	if (details.sftp) {
		const targets = details.sftp.targets.length > 0 ? details.sftp.targets.join(", ") : "(none)";
		lines.push(`sftp uploaded: ${details.sftp.uploaded} to ${targets}`);
		if (details.sftp.errors && details.sftp.errors.length > 0) {
			lines.push(`sftp errors: ${details.sftp.errors.join("; ")}`);
		}
	}

	return lines;
}

function shouldSyncSftp(details: ApplyPatchDetails): boolean {
	if (details.operation === "add") {
		return true;
	}
	if (details.moveTo) {
		return true;
	}
	return typeof details.appliedHunks === "number" && details.appliedHunks > 0;
}

async function maybeSyncSftp(cwd: string, details: ApplyPatchDetails): Promise<SftpSyncDetails | undefined> {
	if (!shouldSyncSftp(details)) {
		return undefined;
	}
	let targets: Awaited<ReturnType<typeof loadSftpTargets>>;
	try {
		targets = await loadSftpTargets(cwd);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			targets: [],
			uploaded: 0,
			errors: [message],
		};
	}
	if (targets.length === 0) {
		return undefined;
	}
	const localPath = details.moveTo ?? details.path;
	const selectedTargets = [targets[targets.length - 1]!];
	const target = selectedTargets[0]!;
	const result = await syncSftpFile({
		cwd,
		localPath,
		targets: selectedTargets,
		requireExisting: target.interactiveAuth,
	});
	return result;
}

function normalizeAddFileLines(lines: string[]): string[] {
	const nonEmpty = lines.filter((line) => line.length > 0);
	if (nonEmpty.length === 0) return lines;

	// Some models emit "+ " as a visual separator in Add File lines.
	// If all non-empty lines share this one-space prefix, strip it once.
	const allNonEmptyStartWithSpace = nonEmpty.every((line) => line.startsWith(" "));
	if (!allNonEmptyStartWithSpace) return lines;

	return lines.map((line) => (line.startsWith(" ") ? line.slice(1) : line));
}

function normalizePatchPath(rawPath: string): string {
	const trimmed = rawPath.trim();
	const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
	if (!withoutAt) {
		throw new Error("Patch file path cannot be empty");
	}
	if (!isAbsolute(withoutAt)) {
		throw new Error(`Patch path must be absolute: ${rawPath}`);
	}
	return withoutAt;
}

function isFileHeader(line: string): boolean {
	return line.startsWith(ADD_FILE) || line.startsWith(UPDATE_FILE);
}

function parseAddFile(lines: string[], startIndex: number): { operation: AddFileOperation; nextIndex: number } {
	const header = lines[startIndex];
	const rawPath = header.slice(ADD_FILE.length);
	const path = normalizePatchPath(rawPath);

	const addLines: string[] = [];
	let i = startIndex + 1;

	while (i < lines.length && lines[i] !== END_PATCH) {
		const line = lines[i];
		if (!line.startsWith("+")) {
			throw new Error(`Add File only allows '+' lines, got: ${line}`);
		}
		addLines.push(line.slice(1));
		i++;
	}

	if (addLines.length === 0) {
		throw new Error("Add File operation requires at least one '+' content line");
	}
	const normalizedLines = normalizeAddFileLines(addLines);

	return {
		operation: { kind: "add", path, lines: normalizedLines },
		nextIndex: i,
	};
}

function parseUpdateFile(lines: string[], startIndex: number): { operation: UpdateFileOperation; nextIndex: number } {
	const header = lines[startIndex];
	const rawPath = header.slice(UPDATE_FILE.length);
	const path = normalizePatchPath(rawPath);

	let moveTo: string | undefined;
	let i = startIndex + 1;
	if (i < lines.length && lines[i].startsWith(MOVE_TO)) {
		moveTo = normalizePatchPath(lines[i].slice(MOVE_TO.length));
		i++;
	}

	const hunks: UpdateHunk[] = [];
	let currentHeaders: string[] | undefined;
	let currentLines: string[] = [];
	let currentLineHint: LineHint | undefined;

	const flushCurrentHunk = () => {
		if (!currentHeaders) return;
		hunks.push({
			headers: currentHeaders,
			lines: currentLines,
			lineHint: currentLineHint,
		});
		currentHeaders = undefined;
		currentLines = [];
		currentLineHint = undefined;
	};

	while (i < lines.length && lines[i] !== END_PATCH) {
		const line = lines[i];
		if (line === END_OF_FILE) {
			i++;
			break;
		}
		if (line.startsWith("@@")) {
			const { headerText, lineHint } = parseHunkHeaderLine(line);
			if (!currentHeaders) {
				currentHeaders = [];
			} else if (currentLines.length > 0) {
				flushCurrentHunk();
				currentHeaders = [];
			}
			if (headerText) {
				currentHeaders.push(headerText);
			}
			if (lineHint && !currentLineHint) {
				currentLineHint = lineHint;
			}
			i++;
			continue;
		}

		const marker = line[0];
		if (marker === " " || marker === "+" || marker === "-") {
			if (!currentHeaders) {
				throw new Error(`Update File change line encountered before hunk header @@: ${line}`);
			}
			currentLines.push(line);
			i++;
			continue;
		}

		if (isFileHeader(line)) {
			throw new Error("Patch must contain exactly one file operation");
		}

		if (!currentHeaders) {
			throw new Error(`Update File change line encountered before hunk header @@: ${line}`);
		}

		// If it's not a recognized command, assume it's a context line that is missing its leading space.
		// Models frequently make this mistake.
		currentLines.push(" " + line);
		i++;
		continue;
	}
	flushCurrentHunk();

	return {
		operation: { kind: "update", path, moveTo, hunks },
		nextIndex: i,
	};
}

function parsePatchDocument(patchText: string): ParseResult {
	const normalized = normalizeLineEndings(patchText);
	const lines = normalized.split("\n");

	if (lines.length === 0 || lines[0] !== BEGIN_PATCH) {
		throw new Error(`Patch must start with "${BEGIN_PATCH}"`);
	}

	let index = 1;
	if (index >= lines.length) {
		throw new Error("Patch is incomplete");
	}

	const opHeader = lines[index] ?? "";
	if (!isFileHeader(opHeader)) {
		throw new Error(`Expected "${ADD_FILE}" or "${UPDATE_FILE}", got: ${opHeader}`);
	}

	const parsed = opHeader.startsWith(ADD_FILE) ? parseAddFile(lines, index) : parseUpdateFile(lines, index);
	index = parsed.nextIndex;

	if (index >= lines.length || lines[index] !== END_PATCH) {
		throw new Error(`Patch must end with "${END_PATCH}"`);
	}

	for (let i = index + 1; i < lines.length; i++) {
		if (lines[i] !== "") {
			throw new Error(`Unexpected trailing content after "${END_PATCH}"`);
		}
	}

	return { operation: parsed.operation };
}

function buildReplacementTexts(hunk: UpdateHunk): { oldText: string; newText: string } {
	const oldLines: string[] = [];
	const newLines: string[] = [];

	for (const line of hunk.lines) {
		const marker = line[0];
		const text = line.slice(1);
		if (marker === " " || marker === "-") oldLines.push(text);
		if (marker === " " || marker === "+") newLines.push(text);
	}

	return {
		oldText: oldLines.join("\n"),
		newText: newLines.join("\n"),
	};
}

function hunkHasChanges(hunk: UpdateHunk): boolean {
	return hunk.lines.some((line) => {
		const marker = line[0];
		return marker === "+" || marker === "-";
	});
}

function parseFirstChangedLine(details: unknown): number | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const record = details as Record<string, unknown>;
	const value = record.firstChangedLine;
	return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function toZeroBasedLine(line: number): number {
	return Math.max(0, line - 1);
}

function parseDiffHeader(header: string): { headerText?: string; lineHint?: LineHint } | null {
	const match = header.match(/^-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(?:\s+(.*))?$/);
	if (!match) return null;

	const oldStart = Number(match[1]);
	const oldCount = match[2] ? Number(match[2]) : undefined;
	const contextText = match[5]?.trim();
	if (!Number.isInteger(oldStart) || oldStart <= 0) {
		return {
			headerText: contextText || undefined,
		};
	}

	const startLine = toZeroBasedLine(oldStart);
	const endLine = oldCount && oldCount > 0 ? startLine + oldCount - 1 : undefined;

	return {
		lineHint: { startLine, endLine },
		headerText: contextText || undefined,
	};
}

function parseLineDirective(header: string): { lineHint: LineHint } | null {
	const match = header.match(/^line\s*(?::|=)?\s*(\d+)(?:\s*(?:-|\.\.)\s*(\d+))?$/i);
	if (!match) return null;

	const start = Number(match[1]);
	if (!Number.isInteger(start) || start <= 0) return null;

	const end = match[2] ? Number(match[2]) : undefined;
	const startLine = toZeroBasedLine(start);
	const endLine = end && end >= start ? toZeroBasedLine(end) : undefined;

	return { lineHint: { startLine, endLine } };
}

function parseHunkHeaderLine(line: string): { headerText?: string; lineHint?: LineHint } {
	const header = line.replace(/^@@/, "").trim();
	if (!header) return {};

	const diffParsed = parseDiffHeader(header);
	if (diffParsed) return diffParsed;

	const lineParsed = parseLineDirective(header);
	if (lineParsed) return lineParsed;

	return { headerText: header };
}

function normalizeHeaderText(header: string): string | undefined {
	const trimmed = header.replace(/^@@/, "").trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function findHeaderSearchStart(fileContent: string, headers: string[]): number | undefined {
	if (headers.length === 0) return undefined;

	const fileLines = normalizeLineEndings(fileContent).split("\n");
	let searchStart = 0;
	let matchedAny = false;

	for (const header of headers) {
		const needle = normalizeHeaderText(header);
		if (!needle) continue;
		matchedAny = true;

		let foundIndex = -1;
		for (let i = searchStart; i < fileLines.length; i++) {
			if (fileLines[i].includes(needle)) {
				foundIndex = i;
				break;
			}
		}
		if (foundIndex === -1) return undefined;
		searchStart = foundIndex + 1;
	}

	return matchedAny ? searchStart : undefined;
}

export function alignReplacement(
	fileContent: string,
	oldText: string,
	newText: string,
	options?: { startLine?: number; endLine?: number },
): { oldText: string; newText: string } | null {
	const fileLines = normalizeLineEndings(fileContent).split("\n");
	const oldLines = normalizeLineEndings(oldText).split("\n");
	const newLines = normalizeLineEndings(newText).split("\n");

	if (oldLines.length === 0) return null;

	const startLine = Math.max(0, options?.startLine ?? 0);
	const maxStart = fileLines.length - oldLines.length;
	const endLine = Math.min(maxStart, options?.endLine ?? maxStart);
	if (startLine > endLine) return null;

	const matches: number[] = [];
	for (let i = startLine; i <= endLine; i++) {
		let match = true;
		for (let j = 0; j < oldLines.length; j++) {
			if (fileLines[i + j].trim() !== oldLines[j].trim()) {
				match = false;
				break;
			}
		}
		if (match) matches.push(i);
	}

	// Only apply alignment if we found exactly one unambiguous match
	if (matches.length === 1) {
		const startIdx = matches[0];
		const exactFileLines = fileLines.slice(startIdx, startIdx + oldLines.length);

		// Build indentation mapping
		const indentationMap = new Map<string, string>();
		for (let i = 0; i < oldLines.length; i++) {
			const oldSpaceMatch = oldLines[i].match(/^\s*/);
			const fileSpaceMatch = exactFileLines[i].match(/^\s*/);
			if (oldSpaceMatch && fileSpaceMatch) {
				const oldSpace = oldSpaceMatch[0];
				const fileSpace = fileSpaceMatch[0];
				if (!indentationMap.has(oldSpace)) {
					indentationMap.set(oldSpace, fileSpace);
				}
			}
		}

		// Align newLines
		const alignedNewLines = newLines.map((newLine) => {
			const newSpaceMatch = newLine.match(/^\s*/);
			if (newSpaceMatch) {
				const newSpace = newSpaceMatch[0];
				if (indentationMap.has(newSpace)) {
					return indentationMap.get(newSpace) + newLine.slice(newSpace.length);
				}
			}
			return newLine;
		});

		return {
			oldText: exactFileLines.join("\n"),
			newText: alignedNewLines.join("\n"),
		};
	}

	return null;
}

export async function applyPatchToFilesystem(options: {
	patchText: string;
	cwd: string;
	toolCallId?: string;
	signal?: AbortSignal;
}): Promise<{ summary: string; details: ApplyPatchDetails }> {
	const toolCallId = options.toolCallId ?? "apply-patch";
	const parsed = parsePatchDocument(options.patchText);
	const patchLineCount = getNormalizedPatchLines(options.patchText).length;
	const normalizedPatchText = normalizeLineEndings(options.patchText);
	const writeTool = createWriteTool(options.cwd);
	const editTool = createEditTool(options.cwd);

	if (parsed.operation.kind === "add") {
		const content = parsed.operation.lines.join("\n");
		await writeTool.execute(
			`${toolCallId}:add`,
			{
				path: parsed.operation.path,
				content,
			},
			options.signal,
		);

		const details: ApplyPatchDetails = {
			operation: "add",
			path: parsed.operation.path,
			bytesWritten: Buffer.byteLength(content, "utf-8"),
			patchLineCount,
			patchText: normalizedPatchText,
		};
		return {
			summary: `Applied patch: added ${parsed.operation.path}`,
			details,
		};
	}

	const firstChangedLines: number[] = [];
	let appliedHunks = 0;
	let noopHunks = 0;
	for (let i = 0; i < parsed.operation.hunks.length; i++) {
		const hunk = parsed.operation.hunks[i];
		if (!hunkHasChanges(hunk)) {
			noopHunks++;
			continue;
		}

		let { oldText, newText } = buildReplacementTexts(hunk);
		if (oldText === newText) {
			noopHunks++;
			continue;
		}

		const absolutePath = isAbsolute(parsed.operation.path)
			? parsed.operation.path
			: resolve(options.cwd, parsed.operation.path);

		if (existsSync(absolutePath)) {
			try {
				const fileContent = readFileSync(absolutePath, "utf-8");
				const headerStart = findHeaderSearchStart(fileContent, hunk.headers);
				const startLine = hunk.lineHint?.startLine ?? headerStart;
				const endLine = hunk.lineHint?.endLine;
				const alignOptions =
					startLine !== undefined || endLine !== undefined ? { startLine, endLine } : undefined;
				const aligned = alignReplacement(fileContent, oldText, newText, alignOptions);
				if (aligned) {
					oldText = aligned.oldText;
					newText = aligned.newText;
				}
			} catch {
				// Ignore read errors, let editTool handle it
			}
		}

		const result = await editTool.execute(
			`${toolCallId}:hunk:${i + 1}`,
			{
				path: parsed.operation.path,
				oldText,
				newText,
			},
			options.signal,
		);
		appliedHunks++;
		const firstChangedLine = parseFirstChangedLine(result.details);
		if (firstChangedLine !== undefined) {
			firstChangedLines.push(firstChangedLine);
		}
	}

	let movedTo: string | undefined;
	if (parsed.operation.moveTo && parsed.operation.moveTo !== parsed.operation.path) {
		await mkdir(dirname(parsed.operation.moveTo), { recursive: true });
		await rename(parsed.operation.path, parsed.operation.moveTo);
		movedTo = parsed.operation.moveTo;
	}

	const details: ApplyPatchDetails = {
		operation: "update",
		path: parsed.operation.path,
		moveTo: movedTo,
		hunkCount: parsed.operation.hunks.length,
		appliedHunks,
		noopHunks,
		firstChangedLines,
		patchLineCount,
		patchText: normalizedPatchText,
	};

	const suffix: string[] = [];
	if (noopHunks > 0) {
		suffix.push(`skipped ${noopHunks} no-op hunk(s)`);
	}
	if (movedTo) {
		suffix.push(`moved to ${movedTo}`);
	}
	const suffixText = suffix.length > 0 ? ` (${suffix.join(", ")})` : "";

	return {
		summary: `Applied patch: updated ${parsed.operation.path} with ${appliedHunks} hunk(s)${suffixText}.`,
		details,
	};
}

export default function (pi: ExtensionAPI) {
	// System prompt injection is handled centrally by system-prompt extension.

	pi.registerTool({
		name: "ApplyPatch",
		label: "Apply Patch",
		description: DESCRIPTION,
		parameters: applyPatchSchema,
		renderCall(args, theme) {
			const patch = typeof args.patch === "string" ? args.patch : "";
			const summary = buildPatchCallSummary(patch);
			let text = theme.fg("toolTitle", theme.bold("ApplyPatch"));
			text += ` ${theme.fg("toolOutput", summary)}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("muted", "Applying patch..."), 0, 0);
			}

			const summary = getResultSummaryText(result.content as Array<{ type: string; text?: string }>);
			const details = result.details as ApplyPatchDetails | undefined;
			const detailLines = buildRenderDetailLines(details);

			let text = theme.fg("toolOutput", summary);
			if (expanded && detailLines.length > 0) {
				text += `\n${detailLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
			} else if (!expanded && detailLines.length > 0) {
				text += ` ${theme.fg("muted", `(${keyHint("expandTools", "to expand")})`)}`;
			}

			return new Text(text, 0, 0);
		},

		async execute(toolCallId, params: ApplyPatchInput, signal, _onUpdate, ctx) {
			const { summary, details } = await applyPatchToFilesystem({
				patchText: params.patch,
				cwd: ctx.cwd,
				toolCallId,
				signal,
			});
			const sftp = await maybeSyncSftp(ctx.cwd, details);
			const outputDetails = sftp ? { ...details, sftp } : details;

			return {
				content: [{ type: "text", text: summary }],
				details: outputDetails,
			};
		},
	});
}
