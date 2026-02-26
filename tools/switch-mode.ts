import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import {
	createModeStateData,
	deriveInitialModeState,
	modeRuntimeStore,
	MODE_STATE_ENTRY_TYPE,
	parseModeStateEntry,
	type ModeId,
} from "../src/extensions/mode-runtime.js";

const MODE_STATUS_KEY = "mono-pilot-mode";

const DESCRIPTION = `Switch the interaction mode to better match the current task. Each mode is optimized for a specific type of work.

## When to Switch Modes

Switch modes proactively when:
1. **Task type changes** - User shifts from asking questions to requesting implementation, or vice versa
2. **Complexity emerges** - What seemed simple reveals architectural decisions or multiple approaches
3. **Debugging needed** - An error, bug, or unexpected behavior requires investigation
4. **Planning needed** - The task is large, ambiguous, or has significant trade-offs to discuss
5. **You're stuck** - Multiple attempts without progress suggest a different approach is needed

## When NOT to Switch

Do NOT switch modes for:
- Simple, clear tasks that can be completed quickly in current mode
- Mid-implementation when you're making good progress
- Minor clarifying questions (just ask them)
- Tasks where the current mode is working well

## Available Modes

### Agent Mode (cannot switch to this mode)
Default implementation mode with full access to all tools for making changes.

### Plan Mode [switchable]
Read-only collaborative mode for designing implementation approaches before coding.

**Switch to Plan when:**
- The task has multiple valid approaches with significant trade-offs
- Architectural decisions are needed (e.g., "Add caching" - Redis vs in-memory vs file-based)
- The task touches many files or systems (large refactors, migrations)
- Requirements are unclear and you need to explore before understanding scope
- You would otherwise ask multiple clarifying questions

**Examples:**
- User: "Add user authentication" → Switch to Plan (session vs JWT, storage, middleware decisions)
- User: "Refactor the database layer" → Switch to Plan (large scope, architectural impact)
- User: "Make the app faster" → Switch to Plan (need to profile, multiple optimization strategies)

### Debug Mode (cannot switch to this mode)
Systematic troubleshooting mode for investigating bugs, failures, and unexpected behavior with runtime evidence.

### Ask Mode (cannot switch to this mode)
Read-only mode for exploring code and answering questions without making changes.

## Important Notes

- **Be proactive**: Don't wait for the user to ask you to switch modes
- **Explain briefly**: When switching, briefly explain why in your \`explanation\` parameter
- **Don't over-switch**: If the current mode is working, stay in it
- **User approval required**: Mode switches require user consent`;

const switchModeSchema = Type.Object({
	target_mode_id: Type.Literal("plan", {
		description: "The mode to switch to. Allowed values: 'plan'",
	}),
	explanation: Type.Optional(
		Type.String({
			description: "Optional explanation for why the mode switch is requested. This helps the user understand why you're switching modes.",
		}),
	),
});

type SwitchModeInput = Static<typeof switchModeSchema>;

interface SwitchModeDetails {
	active_mode: "plan" | "ask" | "agent";
	explanation?: string;
}

interface FooterModelState {
	modelId: string;
	provider?: string;
	reasoning: boolean;
	thinkingLevel: string;
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function deriveFooterModelState(entries: unknown[], fallbackModel: ExtensionContext["model"]): FooterModelState {
	let modelId = fallbackModel?.id || "no-model";
	let provider = fallbackModel?.provider;
	let reasoning = fallbackModel?.reasoning === true;
	let thinkingLevel = "off";

	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as {
			type?: unknown;
			modelId?: unknown;
			provider?: unknown;
			thinkingLevel?: unknown;
		};
		if (record.type === "model_change") {
			if (typeof record.modelId === "string" && record.modelId.length > 0) {
				modelId = record.modelId;
			}
			if (typeof record.provider === "string" && record.provider.length > 0) {
				provider = record.provider;
			}
			reasoning = false;
		}
		if (record.type === "thinking_level_change" && typeof record.thinkingLevel === "string") {
			thinkingLevel = record.thinkingLevel;
			reasoning = true;
		}
	}

	return {
		modelId,
		provider,
		reasoning,
		thinkingLevel,
	};
}

function installModeFooter(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;

	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

		return {
			dispose: unsubscribe,
			invalidate() {},
			render(width: number): string[] {
				let totalInput = 0;
				let totalOutput = 0;
				let totalCacheRead = 0;
				let totalCacheWrite = 0;
				let totalCost = 0;

				const entries = ctx.sessionManager.getEntries();
				for (const entry of entries) {
					if (typeof entry !== "object" || entry === null) continue;
					const record = entry as {
						type?: unknown;
						message?: {
							role?: unknown;
							usage?: {
								input?: unknown;
								output?: unknown;
								cacheRead?: unknown;
								cacheWrite?: unknown;
								cost?: {
									total?: unknown;
								};
							};
						};
					};
					if (record.type !== "message" || record.message?.role !== "assistant") continue;

					totalInput += typeof record.message.usage?.input === "number" ? record.message.usage.input : 0;
					totalOutput += typeof record.message.usage?.output === "number" ? record.message.usage.output : 0;
					totalCacheRead += typeof record.message.usage?.cacheRead === "number" ? record.message.usage.cacheRead : 0;
					totalCacheWrite += typeof record.message.usage?.cacheWrite === "number" ? record.message.usage.cacheWrite : 0;
					totalCost +=
						typeof record.message.usage?.cost?.total === "number" ? record.message.usage.cost.total : 0;
				}

				let pwd = process.cwd();
				const home = process.env.HOME || process.env.USERPROFILE;
				if (home && pwd.startsWith(home)) {
					pwd = `~${pwd.slice(home.length)}`;
				}

				const branch = footerData.getGitBranch();
				if (branch) {
					pwd = `${pwd} (${branch})`;
				}

				const sessionName = ctx.sessionManager.getSessionName();
				if (sessionName) {
					pwd = `${pwd} • ${sessionName}`;
				}

				const extensionStatuses = footerData.getExtensionStatuses();
				const modeStatus = extensionStatuses.get(MODE_STATUS_KEY);
				const locationLine = truncateToWidth(
					`${theme.fg("dim", pwd)}${modeStatus ? ` ${sanitizeStatusText(modeStatus)}` : ""}`,
					width,
					theme.fg("dim", "..."),
				);

				const contextUsage = ctx.getContextUsage();
				const contextWindow = contextUsage?.contextWindow ?? 0;
				const contextPercentValue = contextUsage?.percent ?? 0;
				const contextPercent =
					contextUsage?.percent !== null && contextUsage?.percent !== undefined
						? contextUsage.percent.toFixed(1)
						: "?";

				const statsParts = [];
				if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
				if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
				if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
				if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);

				const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
				if (totalCost || usingSubscription) {
					statsParts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
				}

				const autoIndicator = " (auto)";
				const contextPercentDisplay =
					contextPercent === "?"
						? `?/${formatTokens(contextWindow)}${autoIndicator}`
						: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;

				let contextPercentStr: string;
				if (contextPercentValue > 90) {
					contextPercentStr = theme.fg("error", contextPercentDisplay);
				} else if (contextPercentValue > 70) {
					contextPercentStr = theme.fg("warning", contextPercentDisplay);
				} else {
					contextPercentStr = contextPercentDisplay;
				}
				statsParts.push(contextPercentStr);

				let statsLeft = statsParts.join(" ");
				let statsLeftWidth = visibleWidth(statsLeft);
				if (statsLeftWidth > width) {
					const plainStatsLeft = stripAnsi(statsLeft);
					statsLeft = `${plainStatsLeft.substring(0, width - 3)}...`;
					statsLeftWidth = visibleWidth(statsLeft);
				}

				const modelState = deriveFooterModelState(entries, ctx.model);
				let rightSideWithoutProvider = modelState.modelId;
				if (modelState.reasoning) {
					rightSideWithoutProvider =
						modelState.thinkingLevel === "off"
							? `${modelState.modelId} • thinking off`
							: `${modelState.modelId} • ${modelState.thinkingLevel}`;
				}

				let rightSide = rightSideWithoutProvider;
				if (footerData.getAvailableProviderCount() > 1 && modelState.provider) {
					rightSide = `(${modelState.provider}) ${rightSideWithoutProvider}`;
					if (statsLeftWidth + 2 + visibleWidth(rightSide) > width) {
						rightSide = rightSideWithoutProvider;
					}
				}

				const rightSideWidth = visibleWidth(rightSide);
				const totalNeeded = statsLeftWidth + 2 + rightSideWidth;

				let statsLine: string;
				if (totalNeeded <= width) {
					const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
					statsLine = statsLeft + padding + rightSide;
				} else {
					const availableForRight = width - statsLeftWidth - 2;
					if (availableForRight > 3) {
						const plainRightSide = stripAnsi(rightSide);
						const truncatedPlain = plainRightSide.substring(0, availableForRight);
						const padding = " ".repeat(width - statsLeftWidth - truncatedPlain.length);
						statsLine = statsLeft + padding + truncatedPlain;
					} else {
						statsLine = statsLeft;
					}
				}

				const dimStatsLeft = theme.fg("dim", statsLeft);
				const remainder = statsLine.slice(statsLeft.length);
				const dimRemainder = theme.fg("dim", remainder);
				const lines = [locationLine, dimStatsLeft + dimRemainder];

				const otherStatuses = Array.from(extensionStatuses.entries())
					.filter(([key]) => key !== MODE_STATUS_KEY)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([, text]) => sanitizeStatusText(text));

				if (otherStatuses.length > 0) {
					const statusLine = otherStatuses.join(" ");
					lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
				}

				return lines;
			},
		};
	});
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

function setMode(pi: ExtensionAPI, nextMode: ModeId, ctx?: ExtensionContext): { changed: boolean } {
	const { changed } = modeRuntimeStore.setMode(nextMode);
	if (changed) {
		persistModeState(pi);
	}
	if (ctx) {
		updateModeStatus(ctx);
	}
	return { changed };
}

function togglePlanMode(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const { snapshot } = modeRuntimeStore.toggleMode();
	persistModeState(pi);
	updateModeStatus(ctx);
	if (ctx.hasUI) {
		const label =
			snapshot.activeMode === "plan" ? "Plan" : snapshot.activeMode === "ask" ? "Ask" : "Agent";
		ctx.ui.notify(`Switched to ${label} mode`);
	}
}

export default function switchModeExtension(pi: ExtensionAPI) {
	pi.registerFlag("plan", {
		description: "Start the session in plan mode",
		type: "boolean",
		default: false,
	});

	pi.registerShortcut("alt+m", {
		description: "Cycle between Plan, Ask, and Agent modes",
		handler: async (ctx) => {
			togglePlanMode(pi, ctx);
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		const fromFlag = pi.getFlag("plan") === true;
		const entries = ctx.sessionManager.getEntries();

		let restored = undefined;
		for (let i = entries.length - 1; i >= 0; i--) {
			restored = parseModeStateEntry(entries[i]);
			if (restored !== undefined) break;
		}

		if (restored) {
			modeRuntimeStore.initialize(restored);
		} else {
			modeRuntimeStore.initialize(deriveInitialModeState(fromFlag));
			persistModeState(pi);
		}

		installModeFooter(ctx);
		updateModeStatus(ctx);
	});

	// System prompt injection is handled centrally by system-prompt extension.

	pi.registerTool({
		name: "SwitchMode",
		label: "Switch Mode",
		description: DESCRIPTION,
		parameters: switchModeSchema,
		async execute(_toolCallId, params: SwitchModeInput, _signal, _onUpdate, ctx) {
			const { changed } = setMode(pi, "plan", ctx);

			const explanation = params.explanation?.trim();
			const details: SwitchModeDetails = {
				active_mode: "plan",
				explanation: explanation || undefined,
			};

			const explanationSuffix = explanation ? ` Reason: ${explanation}` : "";
			const prefix = changed ? "Switched to Plan mode." : "Plan mode is already active.";
			return {
				content: [{ type: "text", text: `${prefix}${explanationSuffix}` }],
				details,
			};
		},
	});
}
