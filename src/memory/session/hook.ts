import type {
	ExtensionAPI,
	ExtensionContext,
	SessionSwitchEvent,
	SessionBeforeCompactEvent,
	TurnEndEvent,
} from "@mariozechner/pi-coding-agent";
import { join } from "node:path";
import { deriveAgentId } from "../../brief/paths.js";
import { loadResolvedMemorySearchConfig } from "../config/loader.js";
import { memoryLog } from "../log.js";
import { evaluateSessionFlushDelta } from "./flush-policy.js";
import { buildContentHashSlug } from "./content-hash.js";
import { buildSessionMemoryEntry, writeSessionMemoryFile } from "./entry.js";
import { formatSessionTimestampParts, buildMemoryFilename, getAgentMemoryDir } from "./paths.js";
import { readSessionExcerpt } from "./session-reader.js";
import { flushSessionTranscript } from "./transcript/flush.js";

const SESSION_EXCERPT_MAX_MESSAGES = 50;

async function flushSessionArtifacts(params: {
	reason: "new" | "resume" | "compaction";
	sessionFile: string;
	ctx: ExtensionContext;
trigger: "session-switch" | "session-compact" | "delta-threshold";
}): Promise<void> {
	const agentId = deriveAgentId(params.ctx.cwd);
	memoryLog.info("flush trigger", {
		agentId,
		trigger: params.trigger,
		reason: params.reason,
		sessionFile: params.sessionFile,
	});
	const memoryResult = await flushSessionMemory({
		agentId,
		reason: params.reason,
		sessionFile: params.sessionFile,
	});
	const transcriptResult = await flushSessionTranscript({
		agentId,
		reason: params.reason,
		sessionFile: params.sessionFile,
	});

	memoryLog.info("flush artifacts written", {
		agentId,
		trigger: params.trigger,
		reason: params.reason,
		sessionMemoryWritten: memoryResult.written,
		sessionMemoryPath: memoryResult.filePath,
		sessionTranscriptWritten: transcriptResult.written,
		sessionTranscriptPath: transcriptResult.filePath,
		sessionTranscriptLastLine: transcriptResult.lastLine,
	});
}

async function flushSessionMemory(params: {
	agentId: string;
	reason: "new" | "resume" | "compaction";
	sessionFile: string;
}): Promise<{ written: boolean; filePath?: string }> {
	const excerpt = await readSessionExcerpt(params.sessionFile, SESSION_EXCERPT_MAX_MESSAGES);
	if (excerpt.messages.length === 0) {
		return { written: false };
	}

	const timestamp = new Date();
	const { date, timeSlug } = formatSessionTimestampParts(timestamp);
	const hashInput = [excerpt.sessionId ?? "", ...excerpt.messages.map((msg) => `${msg.role}:${msg.text}`)].join("\n");
	const hashSlug = buildContentHashSlug(hashInput);
	const filePath = join(getAgentMemoryDir(params.agentId), buildMemoryFilename(date, `${timeSlug}-${hashSlug}`));

	const content = buildSessionMemoryEntry({
		timestamp,
		reason: params.reason,
		sessionId: excerpt.sessionId,
		sessionFile: params.sessionFile,
		messages: excerpt.messages,
	});

	await writeSessionMemoryFile(filePath, content);
	return { written: true, filePath };
}

async function handleSessionSwitch(event: SessionSwitchEvent, ctx: ExtensionContext): Promise<void> {
	if (!event.previousSessionFile) return;
	const settings = await loadResolvedMemorySearchConfig();
	if (!settings.enabled || !settings.flush.onSessionSwitch) return;

	await flushSessionArtifacts({
		reason: event.reason,
		sessionFile: event.previousSessionFile,
		ctx,
		trigger: "session-switch",
	});
}

async function handleSessionBeforeCompact(
	_event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
): Promise<void> {
	const settings = await loadResolvedMemorySearchConfig();
	if (!settings.enabled || !settings.flush.onSessionCompact) return;

	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) return;
	await flushSessionArtifacts({
		reason: "compaction",
		sessionFile,
		ctx,
		trigger: "session-compact",
	});
}

async function handleTurnEnd(_event: TurnEndEvent, ctx: ExtensionContext): Promise<void> {
	const settings = await loadResolvedMemorySearchConfig();
	if (!settings.enabled) return;

	const byteThreshold = settings.flush.deltaBytes;
	const messageThreshold = settings.flush.deltaMessages;
	if (byteThreshold <= 0 && messageThreshold <= 0) return;

	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) return;

	const agentId = deriveAgentId(ctx.cwd);
	const delta = await evaluateSessionFlushDelta({
		agentId,
		sessionFile,
		policy: {
			deltaBytes: byteThreshold,
			deltaMessages: messageThreshold,
		},
	});
	memoryLog.info("flush delta evaluated", {
		agentId,
		sessionFile,
		deltaBytes: delta.deltaBytes,
		deltaMessages: delta.deltaMessages,
		thresholdBytes: byteThreshold,
		thresholdMessages: messageThreshold,
		shouldFlush: delta.shouldFlush,
	});

	if (!delta.shouldFlush) return;

	await flushSessionArtifacts({
		reason: "resume",
		sessionFile,
		ctx,
		trigger: "delta-threshold",
	});
}

export function registerSessionMemoryHook(pi: ExtensionAPI): void {
	pi.on("session_switch", async (event, ctx) => {
		try {
			await handleSessionSwitch(event, ctx);
		} catch (error) {
			console.warn(`[memory] session switch flush failed: ${String(error)}`);
			memoryLog.warn("session switch flush failed", { error: String(error) });
			// Best effort: session memory is non-critical.
		}
	});
	pi.on("session_before_compact", async (event, ctx) => {
		try {
			await handleSessionBeforeCompact(event, ctx);
		} catch (error) {
			console.warn(`[memory] session_before_compact flush failed: ${String(error)}`);
			memoryLog.warn("session_before_compact flush failed", { error: String(error) });
			// Best effort: session memory is non-critical.
		}
	});
	pi.on("turn_end", async (event, ctx) => {
		try {
			await handleTurnEnd(event, ctx);
		} catch (error) {
			console.warn(`[memory] turn_end delta flush failed: ${String(error)}`);
			memoryLog.warn("turn_end delta flush failed", { error: String(error) });
		}
	});
}