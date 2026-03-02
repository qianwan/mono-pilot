import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ReadToolDetails } from "@mariozechner/pi-coding-agent";
import { createReadTool, keyHint } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";

// Tool docs are surfaced via system-prompt extension functions namespace.

const DESCRIPTION = `Reads a file from the local filesystem. You can access any file directly by using this tool.
If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters
- Lines in the output are numbered starting at 1, using following format: LINE_NUMBER|LINE_CONTENT
- You have the capability to call multiple tools in a single response. It is always better to speculatively read multiple files as a batch that are potentially useful.
- If you read a file that exists but has empty contents you will receive 'File is empty.'

Image Support:
- This tool can also read image files when called with the appropriate path.
- Supported image formats: jpeg/jpg, png, gif, webp.

PDF Support:
- PDF files are converted into text content automatically (subject to the same character limits as other files).`;

const MAX_RENDER_PATH_CHARS = 120;


const readSchema = Type.Object({
	path: Type.String({ description: "The absolute path of the file to read." }),
	offset: Type.Optional(
		Type.Number({
			description: "The line number to start reading from. Positive values are 1-indexed from the start of the file. Negative values count backwards from the end (e.g. -1 is the last line). Only provide if the file is too large to read at once."
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description: "The number of lines to read. Only provide if the file is too large to read at once."
		})
	),
});

type ReadInput = Static<typeof readSchema>;

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

function getNumericRenderParam(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || Number.isNaN(value)) return undefined;
	return Math.trunc(value);
}

function getTextContent(content: (TextContent | ImageContent)[]): TextContent | undefined {
	return content.find((entry): entry is TextContent => entry.type === "text");
}

function getTotalLinesFromProbe(content: (TextContent | ImageContent)[], details: ReadToolDetails | undefined): number {
	if (details?.truncation) {
		return details.truncation.totalLines;
	}
	const textContent = getTextContent(content);
	if (!textContent) {
		return 0;
	}
	return textContent.text.length === 0 ? 0 : textContent.text.split("\n").length;
}

function normalizeRequestedOffset(offset: number | undefined): number | undefined {
	if (offset === undefined || Number.isNaN(offset)) return undefined;
	return Math.trunc(offset);
}

function computeDisplayStartLine(offset: number | undefined): number {
	if (offset === undefined || offset <= 1) return 1;
	return offset;
}

function mapNegativeOffsetToPositive(offset: number, totalLines: number): number {
	const oneIndexedFromStart = totalLines + offset + 1;
	return Math.max(1, oneIndexedFromStart);
}

function splitTrailingContinuationNotice(text: string): { fileText: string; notice: string | undefined } {
	const marker = "\n\n[";
	const markerIndex = text.lastIndexOf(marker);
	if (markerIndex <= 0) {
		return { fileText: text, notice: undefined };
	}

	const trailing = text.slice(markerIndex + 2);
	if (!/^\[\d+ more lines in file\. Use offset=\d+ to continue\.\]$/.test(trailing)) {
		return { fileText: text, notice: undefined };
	}

	return {
		fileText: text.slice(0, markerIndex),
		notice: trailing,
	};
}

function prefixLineNumbers(text: string, startLine: number, details: ReadToolDetails | undefined): string {
	if (text.length === 0) {
		return "File is empty.";
	}

	const allLines = text.split("\n");
	if (details?.truncation) {
		if (details.truncation.firstLineExceedsLimit) {
			return text;
		}

		const fileContentLineCount = Math.min(details.truncation.outputLines, allLines.length);
		const numbered = allLines
			.slice(0, fileContentLineCount)
			.map((line, index) => `${startLine + index}|${line}`)
			.join("\n");
		const suffix = allLines.slice(fileContentLineCount).join("\n");
		return suffix.length > 0 ? `${numbered}\n${suffix}` : numbered;
	}

	const { fileText, notice } = splitTrailingContinuationNotice(text);
	const numberedText = fileText
		.split("\n")
		.map((line, index) => `${startLine + index}|${line}`)
		.join("\n");
	return notice ? `${numberedText}\n\n${notice}` : numberedText;
}


export default function (pi: ExtensionAPI) {
	// System prompt injection is handled centrally by system-prompt extension.

	pi.registerTool({
		name: "ReadFile",
		label: "ReadFile",
		description: DESCRIPTION,
		parameters: readSchema,
		renderCall(args, theme) {
			const input = args as Partial<ReadInput>;
			const path =
				typeof input.path === "string" && input.path.trim().length > 0
					? compactForCommandArg(input.path, MAX_RENDER_PATH_CHARS)
					: "(missing path)";
			const offset = getNumericRenderParam(input.offset);
			const limit = getNumericRenderParam(input.limit);

			const commandArgs: string[] = [path];
			if (offset !== undefined) commandArgs.push("--offset", String(offset));
			if (limit !== undefined) commandArgs.push("--limit", String(limit));
			const commandText = commandArgs.map(shellQuoteArg).join(" ");

			let text = theme.fg("toolTitle", theme.bold("ReadFile"));
			text += ` ${theme.fg("toolOutput", commandText)}`;

			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("muted", "Reading file..."), 0, 0);
			}

			const textContent = getTextContent(result.content);
			if (!textContent) {
				return new Text("", 0, 0);
			}

			const fullText = textContent.text;
			const lineCount = fullText.split("\n").length;

			if (!expanded) {
				const summary = `${lineCount} lines (click or ${keyHint("expandTools", "to expand")})`;
				return new Text(theme.fg("muted", summary), 0, 0);
			}

			let text = fullText
				.split("\n")
				.map((line: string) => theme.fg("toolOutput", line))
				.join("\n");
			text += theme.fg("muted", `\n(click or ${keyHint("expandTools", "to collapse")})`);
			return new Text(text, 0, 0);
		},

		async execute(toolCallId, params: ReadInput, signal, onUpdate, ctx) {
			const baseReadTool = createReadTool(ctx.cwd);
			const normalizedOffset = normalizeRequestedOffset(params.offset);

			let effectiveOffset = normalizedOffset;
			if (normalizedOffset !== undefined && normalizedOffset < 0) {
				const probe = await baseReadTool.execute(`${toolCallId}:probe`, { path: params.path }, signal, onUpdate);
				const totalLines = getTotalLinesFromProbe(probe.content, probe.details as ReadToolDetails | undefined);
				effectiveOffset = mapNegativeOffsetToPositive(normalizedOffset, totalLines);
			}

			const result = await baseReadTool.execute(
				toolCallId,
				{
					path: params.path,
					offset: effectiveOffset,
					limit: params.limit,
				},
				signal,
				onUpdate,
			);

			const hasImage = result.content.some((entry) => entry.type === "image");
			if (hasImage) {
				return result;
			}

			const startLine = computeDisplayStartLine(effectiveOffset);
			const content = result.content.map((entry, index) => {
				if (entry.type !== "text" || index > 0) {
					return entry;
				}
				return {
					...entry,
					text: prefixLineNumbers(entry.text, startLine, result.details as ReadToolDetails | undefined),
				};
			});

			return {
				content,
				details: result.details,
			};
		},
	});
}
