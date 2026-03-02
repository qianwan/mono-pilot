Launch a new agent to handle complex, multi-step tasks autonomously.

The Subagent tool launches specialized subagents (subprocesses) that autonomously handle complex tasks. Each subagent_type has specific capabilities and tools available to it.

Modes:
- Single mode: provide `description` + `prompt` + `subagent_type`
- Parallel orchestration mode: provide `tasks` (array of subagent tasks)

When using single mode, you must specify `subagent_type` to select which built-in agent type to use.

Background mode:
- Set `is_background=true` (single mode or per-task in `tasks`) to launch asynchronously
- Background runs return immediately with `subagent_id`, `session_path`, and `output_file`
- Resume later with `resume=<subagent_id>`

Project inheritance semantics for subagent profiles:
- Built-in subagent types can be overridden via markdown profiles in agent directories
- Lookup order (high priority last):
  1) `~/.codex/agents`, `~/.claude/agents`, `~/.cursor/agents`
  2) `<workspace>/.codex/agents`, `<workspace>/.claude/agents`, `<workspace>/.cursor/agents`
- Project-level profiles override user-level profiles
- `.cursor` profile entries override `.claude` / `.codex` when names conflict
- Supported profile fields: `name`, `model`, `readonly`, `is_background`, plus markdown body system prompt

VERY IMPORTANT: When exploring the codebase to gather context or to answer a question that is not a needle query for a specific file/class/function, it is STRONGLY RECOMMENDED that you use the Subagent tool with subagent_type="explore" instead of running search commands directly.

Examples:
- user: "Where is the ClientError class defined?" assistant: [Uses Grep directly - this is a needle query for a specific class]
- user: "How does authentication work in this codebase?" assistant: [Uses the Subagent tool with subagent_type="explore" - this requires exploring multiple files to understand the auth flow]
- user: "What is the codebase structure?" assistant: [Uses the Subagent tool with subagent_type="explore"]

If it is possible to explore different areas of the codebase in parallel, you should launch multiple agents concurrently.

When NOT to use the Subagent tool:
- Simple, single or few-step tasks that can be performed by a single agent (using parallel or sequential tool calls) -- just call the tools directly instead.
- For example:
- If you want to read a specific file path, use the Read or Glob tool instead of the Subagent tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use the Glob tool instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead of the Subagent tool, to find the match more quickly

Usage notes:
- Always include a short description (3-5 words) summarizing what the agent will do
- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple Subagent tool use content blocks. IMPORTANT: DO NOT launch more than 4 agents concurrently.
- When the agent is done, it will return a single message back to you. Specify exactly what information the agent should return back in its final response to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.
- Agents can be resumed using the `resume` parameter by passing the agent ID from a previous invocation. When resumed, the agent continues with its full previous context preserved. When NOT resuming, each invocation starts fresh and you should provide a detailed task description with all necessary context.
- When using the Subagent tool, the subagent invocation does not have access to the user's message or prior assistant steps. Therefore, you should provide a highly detailed task description with all necessary context for the agent to perform its task autonomously.
- The subagent's outputs should generally be trusted
- Clearly tell the subagent which tasks you want it to perform, since it is not aware of the user's intent or your prior assistant steps (tool calls, thinking, or messages).
- If the subagent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
- If the user specifies that they want you to run subagents "in parallel", you MUST send a single message with multiple Subagent tool use content blocks. For example, if you need to launch both a code-reviewer subagent and a test-runner subagent in parallel, send a single message with both tool calls.
- You can also use `tasks` for built-in parallel orchestration in one Subagent call. Keep `max_concurrency` <= 4.

Available subagent_types and a quick description of what they do:
- generalPurpose: General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. Use when searching for a keyword or file and not confident you'll find the match quickly.
- explore: Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.
- shell: Command execution specialist for running bash commands. Use this for git operations, command execution, and other terminal tasks.
- browser-use: Perform browser-based testing and web automation. This subagent can navigate web pages, interact with elements, fill forms, and take screenshots. Use this for testing web applications, verifying UI changes, or any browser-based tasks. Use this browser subagent when you need to either: (1) parallelize browser tasks alongside other work, or (2) execute a longer sequence of browser actions that benefit from dedicated context. This subagent_type is stateful; if a browserUse subagent already exists, the previously created subagent will be resumed if you reuse the Task tool with subagent_type set to browserUse. (Auto-resumes most recent agent of this type; `resume` arg is ignored)

Available models:
- fast: Uses the parent model with thinking effort set to low (same model, lower thinking).

When speaking to the USER about which model you selected for a Task/subagent, do NOT reveal these internal model alias names (e.g., fast, alpha, beta, gamma). Instead, use natural language such as "a faster model", "a more capable model", or "the default model".

When choosing a model, prefer `fast` for quick, straightforward tasks to minimize cost and latency. Only choose a named alternative model when there is a specific reason — for example, the task requires deep multi-step reasoning, very high code quality, multimodal understanding, or the user explicitly requests a more capable model.