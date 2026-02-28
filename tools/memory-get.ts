import { keyHint, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { deriveAgentId } from "../src/brief/paths.js";
import { getMemorySearchManager } from "../src/memory/search-manager.js";

const DESCRIPTION =
	"Read a snippet from a memory file returned by memory_search. Supports optional line ranges.";

const memoryGetSchema = Type.Object({
	path: Type.String({ description: "Absolute path to a memory file." }),
	from: Type.Optional(Type.Number({ description: "1-based line number to start from." })),
	lines: Type.Optional(Type.Number({ description: "Number of lines to read." })),
});

type MemoryGetInput = Static<typeof memoryGetSchema>;

interface MemoryGetDetails {
	path: string;
	from?: number;
	lines?: number;
}

export default function memoryGetExtension(pi: ExtensionAPI) {
	pi.registerTool({
		label: "MemoryGet",
		name: "MemoryGet",
		description: DESCRIPTION,
		parameters: memoryGetSchema,
		renderCall(args, theme) {
			const input = args as Partial<MemoryGetInput>;
			const pathArg = typeof input.path === "string" && input.path.trim().length > 0
				? input.path
				: "(missing path)";

			const parts: string[] = [pathArg];
			if (input.from !== undefined) parts.push(`from=${input.from}`);
			if (input.lines !== undefined) parts.push(`lines=${input.lines}`);

			let text = theme.fg("toolTitle", theme.bold("MemoryGet"));
			text += ` ${theme.fg("toolOutput", parts.join(" "))}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("muted", "Reading..."), 0, 0);
			}

			const textBlock = result.content.find(
				(entry): entry is { type: "text"; text: string } => entry.type === "text" && typeof entry.text === "string",
			);
			if (!textBlock || typeof textBlock.text !== "string") {
				return new Text(theme.fg("error", "No text result returned."), 0, 0);
			}

			const fullText = textBlock.text;
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
		execute: async (_toolCallId, params: MemoryGetInput, _signal, _onUpdate, ctx) => {
			const manager = await getMemorySearchManager({
				workspaceDir: ctx.cwd,
				agentId: deriveAgentId(ctx.cwd),
			});
			if (!manager) {
				return {
					content: [
						{ type: "text", text: "Memory get is disabled or unavailable." },
					],
					details: { path: params.path, from: params.from, lines: params.lines, disabled: true },
				};
			}
			try {
				const result = await manager.get(params.path, params.from, params.lines);
				return {
					content: [{ type: "text", text: result.text }],
					details: {
						path: result.path,
						from: params.from,
						lines: params.lines,
					} as MemoryGetDetails,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Memory get failed: ${message}` }],
					details: {
						path: params.path,
						from: params.from,
						lines: params.lines,
					} as MemoryGetDetails,
				};
			}
		},
	});
}
