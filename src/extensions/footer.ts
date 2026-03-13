import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { modeRuntimeStore } from "./mode-runtime.js";

const MODE_STATUS_KEY = "mono-pilot-mode";
const HIT_RATE_STATUS_KEY = "mono-pilot-hit-rate";

function isOpenAIFamilyApi(api: unknown): boolean {
	return (
		api === "openai-completions" ||
		api === "openai-responses" ||
		api === "azure-openai-responses" ||
		api === "openai-codex-responses"
	);
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

function updateHitRateStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;

	const entries = ctx.sessionManager.getEntries();

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as {
			type?: unknown;
			message?: {
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

		if (!isOpenAIFamilyApi(record.message.api)) {
			ctx.ui.setStatus(HIT_RATE_STATUS_KEY, undefined);
			return;
		}

		if (record.message.stopReason === "error" || record.message.stopReason === "aborted") {
			ctx.ui.setStatus(HIT_RATE_STATUS_KEY, ctx.ui.theme.fg("muted", "hit:n/a"));
			return;
		}

		const input = typeof record.message.usage?.input === "number" ? record.message.usage.input : 0;
		const cacheRead = typeof record.message.usage?.cacheRead === "number" ? record.message.usage.cacheRead : 0;
		const inputWithCache = input + cacheRead;

		if (inputWithCache > 0) {
			ctx.ui.setStatus(HIT_RATE_STATUS_KEY, ctx.ui.theme.fg("muted", `hit:${((cacheRead / inputWithCache) * 100).toFixed(1)}%`));
		} else {
			ctx.ui.setStatus(HIT_RATE_STATUS_KEY, ctx.ui.theme.fg("muted", "hit:n/a"));
		}
		return;
	}

	ctx.ui.setStatus(HIT_RATE_STATUS_KEY, undefined);
}

export function updateMonoPilotFooterStatuses(ctx: ExtensionContext): void {
	updateModeStatus(ctx);
	updateHitRateStatus(ctx);
}

export default function footerExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		updateMonoPilotFooterStatuses(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		updateMonoPilotFooterStatuses(ctx);
	});
}
