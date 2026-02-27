import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { LSP } from "../src/lsp/index.js";
import { LspState } from "../src/lsp/state.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DESCRIPTION = `Search for symbols (functions, classes, interfaces, etc.) across the entire workspace using LSP.

- More semantic than text search; understands code structure and filters to meaningful symbols only
- Provide a partial or full symbol name to search for
- Returns up to 10 matching symbols with their kind and file location
- Results formatted as: name (kind) relative/path/to/file.ts:line
- Supported languages: TypeScript/JavaScript, Python (Pyright), Go (gopls), Rust (rust-analyzer)`;

const KIND_NAMES: Record<number, string> = {
  5: "class",
  6: "method",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  23: "struct",
};

const schema = Type.Object({
  query: Type.String({
    description: "Symbol name or partial name to search for.",
  }),
});

type Input = Static<typeof schema>;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "LspSymbols",
    label: "LspSymbols",
    description: DESCRIPTION,
    parameters: schema,
    async execute(_id, params: Input, _signal, _onUpdate, _ctx) {
      const symbols = await LSP.workspaceSymbol(params.query);
      if (symbols.length === 0) {
        return { content: [{ type: "text" as const, text: "No symbols found." }], details: undefined };
      }

      const lines = (symbols as any[]).map((s) => {
        const kind = KIND_NAMES[s.kind as number] ?? `kind:${s.kind}`;
        const uri: string = s.location?.uri ?? "";
        const line: number = (s.location?.range?.start?.line ?? 0) + 1;
        const file = uri.startsWith("file://")
          ? path.relative(LspState.directory, fileURLToPath(uri))
          : uri;
        return `${s.name} (${kind}) ${file}:${line}`;
      });

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: undefined,
      };
    },
  });
}
