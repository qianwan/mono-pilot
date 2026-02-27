# Tools

This directory stores the tool layer for `mono-pilot`.

## Structure

- `*.ts`: tool implementation (registration, validation, execution)
- `*.test.ts`: tool unit tests
- `*-description.md`: shared tool description text consumed by the corresponding tool
- mode reminders
  - `plan-mode-reminder.md`: system reminder injected when entering Plan mode
  - `ask-mode-reminder.md`: system reminder injected when entering Ask mode

Tool descriptions are now loaded by the tool implementation and exposed via the system-prompt extension.

## Current tools

- `shell.ts` / `shell-description.md` (`Shell`)
  - Execute shell commands in the workspace.
- `glob.ts` (`Glob`)
  - Find paths by glob pattern.
- `rg.ts` (`rg`)
  - Search file content with ripgrep.
- `read-file.ts` (`ReadFile`)
  - Read file content with truncation and pagination behavior.
- `delete.ts` (`Delete`)
  - Delete files or directories.
- `semantic-search.ts` / `semantic-search-description.md` (`SemanticSearch`)
  - Search code semantically by intent and meaning.
- `memory-search.ts` (`memory_search`)
  - Search indexed memory files for relevant snippets.
- `memory-get.ts` (`memory_get`)
  - Read a snippet from a memory file.
- `web-search.ts` (`WebSearch`)
  - Search the web for current information with result snippets.
- `web-fetch.ts` (`WebFetch`)
  - Fetch web page content and return readable markdown.
- `ask-question.ts` (`AskQuestion`)
  - Collect structured multiple-choice answers from the user.
- `subagent.ts` / `subagent-description.md` (`Subagent`)
  - Launch delegated subagent subprocesses with foreground/background and parallel orchestration.
- `list-mcp-resources.ts` (`ListMcpResources`)
  - Read `.pi/mcp.json` (project) and `~/.pi/mcp.json` (user) configs to list MCP resources with server metadata.
- `fetch-mcp-resource.ts` (`FetchMcpResource`)
  - Fetch a specific MCP resource by server + URI, optionally writing to workspace.
- `list-mcp-tools.ts` (`ListMcpTools`)
  - Discover remote MCP tools via `tools/list` with server attribution.
  - Supports optional `toolName` filter to return full documentation + input JSON schema for the named tool.
- `call-mcp-tool.ts` (`CallMcpTool`)
  - Call a remote MCP tool by server + tool name + JSON arguments.
- `switch-mode.ts` (`SwitchMode`)
  - Switch runtime interaction mode (tool supports `plan`; `/plan` toggles Plan/Agent).
- `apply-patch.ts` / `apply-patch-description.md` (`ApplyPatch`)
  - Apply single-file patches in `*** Begin Patch` format.

### Brief tools

- `brief-write.ts` (`brief_write`)
  - Write content to a brief file with frontmatter preservation and line-limit validation.

Brief files are stored in `~/.mono-pilot/agents/<agent-id>/brief/`.
Core briefs are auto-injected into the system prompt via `src/brief/blocks.ts`.
Reflection reminders are injected every 25 turns via `src/brief/reflection.ts`.
