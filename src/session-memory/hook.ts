import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionSwitchEvent,
	SessionBeforeCompactEvent,
} from "@mariozechner/pi-coding-agent";
import { deriveAgentId } from "../brief/paths.js";
import { buildSessionMemoryEntry, writeSessionMemoryFile } from "./entry.js";
import { buildContentHashSlug } from "./content-hash.js";
import { getAgentMemoryDir, buildMemoryFilename, formatSessionTimestampParts } from "./paths.js";
import { readSessionExcerpt } from "./session-reader.js";

const DEFAULT_MESSAGE_COUNT = 15;

function shouldHandleEvent(event: SessionSwitchEvent): boolean {
	return event.reason === "new";
}

function resolveMessageCount(): number {
	return DEFAULT_MESSAGE_COUNT;
}

async function writeSessionMemory(params: {
	reason: "new" | "resume" | "compaction";
	sessionFile: string;
	ctx: ExtensionContext;
}): Promise<void> {
	const messageCount = resolveMessageCount();
	const excerpt = await readSessionExcerpt(params.sessionFile, messageCount);
	if (excerpt.messages.length === 0) return;

	const agentId = deriveAgentId(params.ctx.cwd);
	const now = new Date();
	const { date, timeSlug } = formatSessionTimestampParts(now);
	const formattedExcerpt = excerpt.messages.map((message) => `${message.role}: ${message.text}`).join("\n");
	const hashSlug = buildContentHashSlug(formattedExcerpt || timeSlug);
	const finalSlug = hashSlug || timeSlug;
	const filename = buildMemoryFilename(`${date}-${timeSlug}`, finalSlug);
	const memoryPath = join(getAgentMemoryDir(agentId), filename);
	const content = buildSessionMemoryEntry({
		timestamp: now,
		reason: params.reason,
		sessionId: excerpt.sessionId,
		sessionFile: params.sessionFile,
		messages: excerpt.messages,
	});

	await writeSessionMemoryFile(memoryPath, content);
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