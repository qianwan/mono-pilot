# MonoPilot

> Cursor-compatible coding agent profile powered by [pi](https://github.com/badlogic/pi-mono).

MonoPilot is a lightweight, highly customizable Cursor-compatible coding agent built on top of the [pi](https://github.com/badlogic/pi-mono) framework. It is designed for developers who want full control over how their coding agent behaves, prefer not to pay a middleman, and want to explore the limits of a lean agent architecture.

## Why MonoPilot

- Transparent prompt/runtime envelope with inspection tooling.
- Cursor-styled tool layer replaces default pi tools so launch-time capability and behavior are defined by MonoPilot.
- Extensible tool layer with MCP support for custom tools and resources.

## Quickstart

```bash
# Run directly without global install
npx mono-pilot

# Or install globally
npm install -g mono-pilot
mono-pilot
```

## Usage

```bash
# Interactive
mono-pilot

# One-shot prompt
mono-pilot -p "Refactor this module"

# Continue previous session
mono-pilot --continue
```

By default, `mono-pilot` launches pi with:

- `--no-extensions`
- `--extension <mono-pilot extension>`
- `--tools ls` (only when you do not pass `--tools` or `--no-tools`)

If you pass `--tools`, MonoPilot removes built-in `edit`, `write`, `read`, `grep`, `glob`, and `bash` so the extension-provided Cursor-styled tools are used instead. If the list becomes empty, it falls back to `ls`. The write path is provided by the `ApplyPatch` tool from the extension.

## What ships now

- `src/cli.ts` – launcher that wraps `pi`
- `src/extensions/mono-pilot.ts` – extension entrypoint (tool wiring)
- `src/extensions/system-prompt.ts` – provider-agnostic prompt stack
- `src/extensions/user-message.ts` – user message envelope assembly
- `tools/` – tool implementations and descriptions (see `tools/README.md`)

## Cursor-styled tools

MonoPilot exposes a Cursor-style tool set to highlight capability at launch:

These replace pi defaults such as `edit`, `write`, `read`, `grep`, `glob`, and `bash`.

Default-to-MonoPilot mapping:

- `edit` / `write` → `ApplyPatch`
- `read` → `ReadFile`
- `grep` → `rg`
- `glob` → `Glob`
- `bash` → `Shell`

The full Cursor-styled tool list exposed by the extension:

- `Shell` – execute shell commands in the workspace
- `Glob` – find paths by glob pattern
- `rg` – search file content with ripgrep
- `ReadFile` – read file content with pagination
- `Delete` – delete files or directories
- `SemanticSearch` – semantic search by intent
- `WebSearch` – search the web with snippets
- `WebFetch` – fetch and render web content
- `AskQuestion` – collect structured multiple-choice answers
- `Subagent` – launch delegated subprocesses
- `ListMcpResources` – list MCP resources from config
- `FetchMcpResource` – fetch a specific MCP resource
- `ListMcpTools` – discover MCP tools and schemas
- `CallMcpTool` – invoke MCP tools by name
- `SwitchMode` – switch interaction mode (`option + m`, cycles Plan → Ask → Agent)
- `ApplyPatch` – apply single-file patches

## User rules

MonoPilot can inject workspace user rules into the runtime envelope on each input (handled by `src/extensions/user-message.ts`).

- Rules live in `.pi/rules/*.rule.txt` under the workspace root
- Each file becomes one `<user_rule>` block wrapped by a `<rules>` envelope
- Files are read in filename order; empty files are ignored
- If no rules are present, the `<rules>` section is omitted

## MCP

- The user message envelope issues a lightweight MCP server `initialize` request to collect server instructions.
- MCP tools then progressively load and surface resources, schemas, and execution only when needed.

## Local development

```bash
git clone https://github.com/qianwan/mono-pilot.git
cd mono-pilot
npm install
npm run build
```

Source-mode development (no build needed on each change):

```bash
# Run from TypeScript sources directly
npm run dev

# Optional: auto-restart on file changes
npm run dev:watch

# Continue the latest session from source mode
npm run dev:continue

# Auto-restart + continue latest session
npm run dev:watch:continue
```

## Prompt inspection

```bash
# Build first (ensures dist extension exists)
npm run build

# Print injected system prompt + runtime envelope (snippet)
npm run inspect:injection

# Print full prompt and envelope to stdout
npm run inspect:injection:full

# Provide a custom user query to render
node scripts/inspect-injection.mjs --query="Summarize this repo"
```

The report shows:
- the final system prompt after tool injection
- the runtime envelope built from `<rules>`, `<mcp_instructions>`, `<system_reminder>`, and `<user_query>`


## License

MIT
