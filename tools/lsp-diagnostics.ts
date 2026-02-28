import { keyHint, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
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
    renderCall(args, theme) {
      const input = args as Partial<Input>;
      const file = typeof input.file === "string" && input.file.trim().length > 0
        ? input.file
        : "(missing file)";

      let text = theme.fg("toolTitle", theme.bold("LspDiagnostics"));
      text += ` ${theme.fg("toolOutput", file)}`;
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg("muted", "Checking..."), 0, 0);
      }

      const textBlock = result.content.find(
        (entry): entry is { type: "text"; text: string } => entry.type === "text" && typeof entry.text === "string",
      );
      if (!textBlock) {
        return new Text(theme.fg("error", "No text result returned."), 0, 0);
      }

      const fullText = textBlock.text;
      const lineCount = fullText.split("\n").length;
      const isClean = fullText === "No diagnostics.";

      if (!expanded) {
        const summary = isClean
          ? theme.fg("muted", "No diagnostics.")
          : `${theme.fg("error", `${lineCount} diagnostics`)} ${theme.fg("muted", `(click or ${keyHint("expandTools", "to expand")})`)}`;
        return new Text(summary, 0, 0);
      }

      let text = fullText
        .split("\n")
        .map((line: string) => (isClean ? theme.fg("muted", line) : theme.fg("toolOutput", line)))
        .join("\n");
      text += theme.fg("muted", `\n(click or ${keyHint("expandTools", "to collapse")})`);
      return new Text(text, 0, 0);
    },
    async execute(_id, params: Input, _signal, _onUpdate, _ctx) {
      await LSP.touchFile(params.file, true);
      const all = await LSP.diagnostics();
      const diags = all[params.file] ?? [];
      const text =
        diags.length === 0
          ? "No diagnostics."
          : diags.map((d) => LSP.Diagnostic.pretty(d)).join("\n");
      return { content: [{ type: "text" as const, text }], details: { file: params.file, count: diags.length } };
    },
  });
}
