import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	createModeStateData,
	modeRuntimeStore,
	MODE_STATE_ENTRY_TYPE,
	type ModeId,
} from "../extensions/mode-runtime.js";

const MODE_STATUS_KEY = "mono-pilot-mode";
const DESCRIPTION = `
Use this tool when you are in Plan mode, have finished updating the plan file, and are ready to leave Plan mode.

## How This Tool Works
- You should have already written your plan to the plan file specified in the plan mode system message
- This tool does NOT take plan content as input
- This tool switches the runtime mode from Plan to Agent
- Approval still happens in normal conversation with the user after exiting Plan mode

## When to Use This Tool
IMPORTANT: Only use this tool when the task requires planning implementation steps for code changes. For research-only tasks where you're gathering information, searching files, or reading files, do NOT use this tool.

## Before Using This Tool
Ensure your plan is complete and unambiguous:
- If you have unresolved questions about requirements or approach, use AskQuestion first
- If you do not see a plan file path in system_reminder, do NOT call this tool because there is no concrete plan artifact to finalize and no need to exit Plan mode for execution.
- Once your plan is finalized, use THIS tool to exit Plan mode

**Important:** Do NOT use AskQuestion to ask generic approval prompts like "Is this plan okay?" or "Should I proceed?". Exit Plan mode first, then continue the approval conversation naturally.

## Examples

1. Initial task: "Search for and understand the implementation of vim mode in the codebase" - Do not use the exit plan mode tool because you are not planning the implementation steps of a task.
2. Initial task: "Help me implement yank mode for vim" - Use the exit plan mode tool after you have finished planning the implementation steps of the task.
3. Initial task: "Add a new feature to handle user authentication" - If unsure about auth method (OAuth, JWT, etc.), use AskQuestion first, then use exit plan mode tool after clarifying the approach.
`.trim()

const exitPlanModeSchema = Type.Object({});

interface ExitPlanModeDetails {
	previous_mode: ModeId;
	active_mode: ModeId;
	changed: boolean;
	plan_file?: string;
}

function updateModeStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const { activeMode } = modeRuntimeStore.getSnapshot();
	const statusText =
		activeMode === "plan"
			? ctx.ui.theme.fg("warning", "mode:plan")
			: activeMode === "ask"
				? ctx.ui.theme.fg("borderAccent", "mode:ask")
				: ctx.ui.theme.fg("muted", "mode:agent");
	ctx.ui.setStatus(MODE_STATUS_KEY, statusText);
}

function persistModeState(pi: ExtensionAPI): void {
	pi.appendEntry(MODE_STATE_ENTRY_TYPE, createModeStateData(modeRuntimeStore.getSnapshot()));
}

export default function exitPlanModeExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ExitPlanMode",
		label: "ExitPlanMode",
		description: DESCRIPTION,
		parameters: exitPlanModeSchema,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const before = modeRuntimeStore.getSnapshot();

			if (before.activeMode !== "plan") {
				const details: ExitPlanModeDetails = {
					previous_mode: before.activeMode,
					active_mode: before.activeMode,
					changed: false,
					plan_file: before.planFilePath,
				};
				return {
					content: [{ type: "text", text: "Plan mode is not active." }],
					details,
				};
			}

			const { changed, snapshot } = modeRuntimeStore.setMode("agent");
			if (changed) {
				persistModeState(pi);
			}
			updateModeStatus(ctx);

			const details: ExitPlanModeDetails = {
				previous_mode: before.activeMode,
				active_mode: snapshot.activeMode,
				changed,
				plan_file: snapshot.planFilePath,
			};

			return {
				content: [{ type: "text", text: "Exited Plan mode. Switched to Agent mode." }],
				details,
			};
		},
	});
}
