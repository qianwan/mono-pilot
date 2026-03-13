import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { deriveAgentId } from "../agents-paths.js";
import { extractMonoPilotObservabilityConfig } from "../config/observability.js";
import { loadMonoPilotConfigObject } from "../config/mono-pilot.js";
import { logMonoPilotObservabilityEvent } from "../observability/mono-pilot.js";
import { setMonoPilotObservabilityConfig } from "../observability/mono-pilot.js";
import { modeRuntimeStore } from "./mode-runtime.js";

const MODE_STATUS_KEY = "mono-pilot-mode";
const HIT_RATE_STATUS_KEY = "mono-pilot-hit-rate";
let observabilityConfigured = false;

function isOpenAIFamilyApi(api: unknown): boolean {
	return (
		api === "openai-completions" ||
		api === "openai-responses" ||
		api === "azure-openai-responses" ||
		api === "openai-codex-responses"
	);
}

type HitRateState =
	| "ok"
	| "no_usage"
	| "terminal_error"
	| "terminal_aborted"
	| "latest_non_openai"
	| "no_assistant";

interface HitRateSnapshot {
	state: HitRateState;
	statusText: string | null;
	percent: number | null;
	messageId: string | null;
	api: string | null;
	stopReason: string | null;
	input: number;
	cacheRead: number;
	inputWithCache: number;
}

function toStringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

function extractAssistantMessageId(record: {
	id?: unknown;
	messageId?: unknown;
	message?: { id?: unknown; messageId?: unknown; responseId?: unknown };
}): string | null {
	const candidates = [
		record.id,
		record.messageId,
		record.message?.id,
		record.message?.messageId,
		record.message?.responseId,
	];

	for (const value of candidates) {
		const parsed = toStringOrNull(value);
		if (parsed) {
			return parsed;
		}
	}

	return null;
}

function computeLatestHitRateSnapshot(ctx: ExtensionContext): HitRateSnapshot {
	const entries = ctx.sessionManager.getEntries();

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as {
			id?: unknown;
			messageId?: unknown;
			type?: unknown;
			message?: {
				id?: unknown;
				messageId?: unknown;
				responseId?: unknown;
				role?: unknown;
				api?: unknown;
				stopReason?: unknown;
				usage?: {
					input?: unknown;
					cacheRead?: unknown;
				};
			};
		};

		if (record.type !== "message" || record.message?.role !== "assistant") continue;

		const messageId = extractAssistantMessageId(record);
		const api = toStringOrNull(record.message.api);
		if (!isOpenAIFamilyApi(record.message.api)) {
			return {
				state: "latest_non_openai",
				statusText: null,
				percent: null,
				messageId,
				api,
				stopReason: toStringOrNull(record.message.stopReason),
				input: 0,
				cacheRead: 0,
				inputWithCache: 0,
			};
		}

		const stopReason = toStringOrNull(record.message.stopReason);
		if (stopReason === "error" || stopReason === "aborted") {
			return {
				state: stopReason === "error" ? "terminal_error" : "terminal_aborted",
				statusText: "hit:n/a",
				percent: null,
				messageId,
				api,
				stopReason,
				input: 0,
				cacheRead: 0,
				inputWithCache: 0,
			};
		}

		const input = typeof record.message.usage?.input === "number" ? record.message.usage.input : 0;
		const cacheRead = typeof record.message.usage?.cacheRead === "number" ? record.message.usage.cacheRead : 0;
		const inputWithCache = input + cacheRead;

		if (inputWithCache > 0) {
			const percent = (cacheRead / inputWithCache) * 100;
			return {
				state: "ok",
				statusText: `hit:${percent.toFixed(1)}%`,
				percent,
				messageId,
				api,
				stopReason,
				input,
				cacheRead,
				inputWithCache,
			};
		}

		return {
			state: "no_usage",
			statusText: "hit:n/a",
			percent: null,
			messageId,
			api,
			stopReason,
			input,
			cacheRead,
			inputWithCache,
		};
	}

	return {
		state: "no_assistant",
		statusText: null,
		percent: null,
		messageId: null,
		api: null,
		stopReason: null,
		input: 0,
		cacheRead: 0,
		inputWithCache: 0,
	};
}

function updateModeStatus(ctx: ExtensionContext): "agent" | "plan" | "ask" {
	const { activeMode } = modeRuntimeStore.getSnapshot();
	if (ctx.hasUI) {
		const statusText =
			activeMode === "plan"
				? ctx.ui.theme.fg("warning", "mode:plan")
				: activeMode === "ask"
					? ctx.ui.theme.fg("borderAccent", "mode:ask")
					: ctx.ui.theme.fg("muted", "mode:agent");
		ctx.ui.setStatus(MODE_STATUS_KEY, statusText);
	}
	return activeMode;
}

function updateHitRateStatus(ctx: ExtensionContext): HitRateSnapshot {
	const snapshot = computeLatestHitRateSnapshot(ctx);
	if (ctx.hasUI) {
		if (snapshot.statusText) {
			ctx.ui.setStatus(HIT_RATE_STATUS_KEY, ctx.ui.theme.fg("muted", snapshot.statusText));
		} else {
			ctx.ui.setStatus(HIT_RATE_STATUS_KEY, undefined);
		}
	}
	return snapshot;
}

function logFooterStatusSnapshot(
	ctx: ExtensionContext,
	mode: "agent" | "plan" | "ask",
	hitRate: HitRateSnapshot,
): void {
	const sessionManager = ctx.sessionManager as { getSessionId?: () => unknown };
	const sessionIdRaw = sessionManager.getSessionId?.();
	const sessionId = typeof sessionIdRaw === "string" ? sessionIdRaw : undefined;

	logMonoPilotObservabilityEvent(
		"footer_status_snapshot",
		{
			mode,
			hasUI: ctx.hasUI,
			assistantMessageId: hitRate.messageId,
			statusHitText: hitRate.statusText,
			hitRatePercent: hitRate.percent,
			hitRateState: hitRate.state,
			api: hitRate.api,
			stopReason: hitRate.stopReason,
			input: hitRate.input,
			cacheRead: hitRate.cacheRead,
			inputWithCache: hitRate.inputWithCache,
			modelProvider: ctx.model?.provider ?? null,
			modelId: ctx.model?.id ?? null,
			cwd: ctx.cwd,
		},
		{
			agentId: deriveAgentId(ctx.cwd),
			sessionId,
			scope: "footer",
		},
	);
}

async function ensureObservabilityConfigLoaded(): Promise<void> {
	if (observabilityConfigured) {
		return;
	}

	try {
		const config = await loadMonoPilotConfigObject();
		setMonoPilotObservabilityConfig(extractMonoPilotObservabilityConfig(config));
	} catch {
		// Keep observability config failures non-fatal.
	}

	observabilityConfigured = true;
}

export function updateMonoPilotFooterStatuses(ctx: ExtensionContext): void {
	updateMonoPilotFooterStatusesWithOptions(ctx, { emitObservability: false });
}

function updateMonoPilotFooterStatusesWithOptions(
	ctx: ExtensionContext,
	options?: { emitObservability?: boolean },
): void {
	const mode = updateModeStatus(ctx);
	const hitRate = updateHitRateStatus(ctx);
	if (options?.emitObservability === true) {
		logFooterStatusSnapshot(ctx, mode, hitRate);
	}
}

export default function footerExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		await ensureObservabilityConfigLoaded();
		updateMonoPilotFooterStatusesWithOptions(ctx, { emitObservability: false });
	});

	pi.on("turn_end", async (_event, ctx) => {
		await ensureObservabilityConfigLoaded();
		updateMonoPilotFooterStatusesWithOptions(ctx, { emitObservability: true });
	});
}
