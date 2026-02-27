import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { LSP } from "../src/lsp/index.js";

const DESCRIPTION = `Get LSP diagnostics (type errors, warnings, hints) for a specific file.

- Run after editing a file to verify no errors were introduced
- Provide the absolute path to the file
- Results formatted as: SEVERITY [line:col] message
- Returns "No diagnostics." if the file has no issues
- Language server is started automatically on first use
- Supported languages: TypeScript/JavaScript, Python (Pyright), Go (gopls), Rust (rust-analyzer)`;

const schema = Type.Object({
  file: Type.String({
    description: "Absolute path to the file to check for diagnostics.",
  }),
});

type Input = Static<typeof schema>;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "LspDiagnostics",
    label: "LspDiagnostics",
    description: DESCRIPTION,
    parameters: schema,
    async execute(_id, params: Input, _signal, _onUpdate, _ctx) {
      await LSP.touchFile(params.file, true);
      const all = await LSP.diagnostics();
      const diags = all[params.file] ?? [];
      const text =
        diags.length === 0
          ? "No diagnostics."
          : diags.map((d) => LSP.Diagnostic.pretty(d)).join("\n");
      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  });
}
