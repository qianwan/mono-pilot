import type {
	ExtensionAPI,
	ExtensionContext,
	SessionSwitchEvent,
	SessionBeforeCompactEvent,
} from "@mariozechner/pi-coding-agent";
import { deriveAgentId } from "../../brief/paths.js";
import { flushSessionTranscript } from "./transcript/flush.js";

function shouldHandleEvent(event: SessionSwitchEvent): boolean {
	return event.reason === "new";
}

async function writeSessionMemory(params: {
	reason: "new" | "resume" | "compaction";
	sessionFile: string;
	ctx: ExtensionContext;
}): Promise<void> {
	const agentId = deriveAgentId(params.ctx.cwd);
	await flushSessionTranscript({
		agentId,
		reason: params.reason,
		sessionFile: params.sessionFile,
	});
}

async function handleSessionSwitch(event: SessionSwitchEvent, ctx: ExtensionContext): Promise<void> {
	if (!shouldHandleEvent(event)) return;
	if (!event.previousSessionFile) return;

	await writeSessionMemory({
		reason: event.reason,
		sessionFile: event.previousSessionFile,
		ctx,
	});
}

async function handleSessionBeforeCompact(
	_event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
): Promise<void> {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) return;
	await writeSessionMemory({
		reason: "compaction",
		sessionFile,
		ctx,
	});
}

export function registerSessionMemoryHook(pi: ExtensionAPI): void {
	pi.on("session_switch", async (event, ctx) => {
		try {
			await handleSessionSwitch(event, ctx);
		} catch {
			// Best effort: session memory is non-critical.
		}
	});
	pi.on("session_before_compact", async (event, ctx) => {
		try {
			await handleSessionBeforeCompact(event, ctx);
		} catch {
			// Best effort: session memory is non-critical.
		}
	});
}