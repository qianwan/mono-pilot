import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { onCompaction } from "../brief/reflection.js";
import lsExtension from "../tools/ls.js";
import shellExtension from "../tools/shell.js";
import globExtension from "../tools/glob.js";
import rgExtension from "../tools/rg.js";
import readFileExtension from "../tools/read-file.js";
import deleteExtension from "../tools/delete.js";
import semanticSearchExtension from "../tools/semantic-search.js";
import webSearchExtension from "../tools/web-search.js";
import webFetchExtension from "../tools/web-fetch.js";
import askQuestionExtension from "../tools/ask-question.js";
import subagentExtension from "../tools/subagent.js";
import listMcpResourcesExtension from "../tools/list-mcp-resources.js";
import fetchMcpResourceExtension from "../tools/fetch-mcp-resource.js";
import listMcpToolsExtension from "../tools/list-mcp-tools.js";
import callMcpToolExtension from "../tools/call-mcp-tool.js";
import switchModeExtension from "../tools/switch-mode.js";
import applyPatchExtension from "../tools/apply-patch.js";
import userMessageExtension from "./user-message.js";
import systemPromptExtension from "./system-prompt.js";
import sessionHintsExtension from "./session-hints.js";
import lspDiagnosticsExtension from "../tools/lsp-diagnostics.js";
import lspSymbolsExtension from "../tools/lsp-symbols.js";
import { LSP } from "../lsp/index.js";
import briefWriteExtension from "../tools/brief-write.js";
import { registerSessionMemoryHook } from "../memory/session/hook.js";
import { closeMemorySearchManagers, setMemoryWorkersEmbeddingProvider } from "../memory/runtime/index.js";
import { closeClusterEmbeddingService, getClusterEmbeddingService } from "../cluster/embedding-service.js";

import { warmMemorySearch } from "../memory/warm.js";
import { deriveAgentId } from "../agents-paths.js";
import { loadResolvedMemorySearchConfig } from "../memory/config/loader.js";
import memorySearchExtension from "../tools/memory-search.js";
import memoryGetExtension from "../tools/memory-get.js";
import { registerBuildMemoryCommand } from "./commands/build-memory.js";
import { registerBusCommands, setBusHandle } from "./commands/bus.js";
import { connectBus, type BusHandle } from "../cluster/bus.js";
import busSendExtension, { setBusSendHandle } from "../tools/bus-send.js";
import type { MessagePushPayload } from "../cluster/protocol.js";

const toolExtensions: ExtensionFactory[] = [
	shellExtension,
	globExtension,
	rgExtension,
	readFileExtension,
	deleteExtension,
	lsExtension,
	semanticSearchExtension,
	webSearchExtension,
	webFetchExtension,
	askQuestionExtension,
	subagentExtension,
	listMcpResourcesExtension,
	fetchMcpResourceExtension,
	listMcpToolsExtension,
	callMcpToolExtension,
	switchModeExtension,
	applyPatchExtension,
	userMessageExtension,
	systemPromptExtension,
	sessionHintsExtension,
	lspDiagnosticsExtension,
	lspSymbolsExtension,
	briefWriteExtension,
	memorySearchExtension,
	memoryGetExtension,
	busSendExtension,
];

export default function monoPilotExtension(pi: ExtensionAPI) {
	for (const register of toolExtensions) {
		register(pi);
	}

	registerSessionMemoryHook(pi);
	registerBuildMemoryCommand(pi);
	registerBusCommands(pi);

	let busHandle: BusHandle | null = null;
	// Debounced bus message injection into agent conversation
	let pendingBusMessages: MessagePushPayload[] = [];
	let flushTimer: ReturnType<typeof setTimeout> | null = null;

	function flushBusMessages(): void {
		if (pendingBusMessages.length === 0) return;
		const msgs = pendingBusMessages;
		pendingBusMessages = [];
		flushTimer = null;

		const lines = msgs.map((m) => {
			const text =
				typeof m.payload === "object" && m.payload !== null && "text" in m.payload
					? (m.payload as { text: string }).text
					: JSON.stringify(m.payload);
			const ch = m.channel && m.channel !== "public" ? ` [${m.channel}]` : "";
			return `[from ${m.from}${ch}] ${text}`;
		});

		const envelope =
			"<bus_messages>\n" + lines.join("\n") + "\n</bus_messages>\n\n" +
			"You received the above messages from other agents via the message bus. " +
			"Respond in character. Use the bus_send tool to reply.";

		pi.sendUserMessage(envelope, { deliverAs: "followUp" });
	}

	function onBusMessage(msg: MessagePushPayload): void {
		pendingBusMessages.push(msg);
		if (flushTimer) clearTimeout(flushTimer);
		flushTimer = setTimeout(flushBusMessages, 300);
	}

	pi.on("session_start", async (_event, ctx) => {
		LSP.init(ctx.cwd);
		const agentId = deriveAgentId(ctx.cwd);
		const sessionManager = (ctx as any).sessionManager;
		// Fire-and-forget: init cluster + warm index without blocking session
		(async () => {
			const settings = await loadResolvedMemorySearchConfig();
			if (settings.enabled && settings.provider === "local") {
				const service = await getClusterEmbeddingService({
					...settings.local,
					agentId,
					getSessionId: () => sessionManager?.getSessionId?.() ?? "unknown",
				});
				setMemoryWorkersEmbeddingProvider(service.provider);
				// Connect to message bus
				try {
					if (service.client) {
						busHandle = await connectBus(service.client, agentId);
						busHandle.onMessage(onBusMessage);
					}
					setBusHandle(busHandle);
					setBusSendHandle(busHandle);
				} catch (err) {
					console.warn(`[bus] connect failed: ${String(err)}`);
				}
			}
			await warmMemorySearch({ workspaceDir: ctx.cwd, agentId });
		})().catch((error) => {
			console.warn(`[memory] warm failed: ${String(error)}`);
		});
	});

	pi.on("session_compact", async () => {
		onCompaction();
	});

	pi.on("session_shutdown", async () => {
		try {
			if (busHandle) {
				busHandle.close();
				setBusHandle(null);
				setBusSendHandle(null);
				busHandle = null;
			}
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}
			await closeMemorySearchManagers();
			await closeClusterEmbeddingService();
		} catch (error) {
			console.warn(`[memory] shutdown cleanup failed: ${String(error)}`);
		}
	});
}
