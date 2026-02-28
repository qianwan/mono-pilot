import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
