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
import generateImageExtension from "../tools/generate-image.js";
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
import briefWriteExtension from "../tools/brief-write.js";
import memorySearchExtension from "../tools/memory-search.js";
import memoryGetExtension from "../tools/memory-get.js";
import busSendExtension, { setBusSendHandle } from "../tools/bus-send.js";
import mailboxExtension from "../tools/mailbox.js";
import { registerSessionMemoryHook } from "../memory/session/hook.js";
import { registerBuildMemoryCommand } from "./commands/build-memory.js";
import { registerBusCommands, setBusHandle } from "./commands/bus.js";
import { registerImageModelCommands } from "./commands/image-model.js";
import { registerSftpCommands } from "./sftp.js";
import { initSubsystems, shutdownSubsystems, type SubsystemHandles } from "./lifecycle.js";

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
	generateImageExtension,
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
	mailboxExtension,
];

export default function monoPilotExtension(pi: ExtensionAPI) {
	for (const register of toolExtensions) {
		register(pi);
	}

	registerSessionMemoryHook(pi);
	registerBuildMemoryCommand(pi);
	registerBusCommands(pi);
	registerImageModelCommands(pi);
	registerSftpCommands(pi);

	let handles: SubsystemHandles | null = null;

	pi.on("session_start", async (_event, ctx) => {
		if (handles) {
			setBusHandle(null);
			setBusSendHandle(null);
			await shutdownSubsystems(handles);
			handles = null;
		}

		try {
			const h = await initSubsystems(pi, ctx, {
				busMessageInjector: (msg) => {
					const text =
						typeof msg.payload === "object" && msg.payload !== null && "text" in msg.payload
							? (msg.payload as { text: string }).text
							: JSON.stringify(msg.payload);
					const sender = msg.fromName ? `${msg.fromName} (${msg.from})` : msg.from;
					const ch = msg.channel && msg.channel !== "public" ? ` [${msg.channel}]` : "";
					const envelope =
						`<bus_messages>\n[from ${sender}${ch}] ${text}\n</bus_messages>\n\n` +
						"You received the above messages from other agents via the message bus.";
					pi.sendUserMessage(envelope, { deliverAs: "followUp" });
				},
			});
			handles = h;
			setBusHandle(h.bus);
			setBusSendHandle(h.bus);
		} catch (err) {
			console.warn(`[subsystems] init failed: ${String(err)}`);
		}
	});

	pi.on("session_compact", async () => {
		onCompaction();
	});

	pi.on("session_shutdown", async () => {
		setBusHandle(null);
		setBusSendHandle(null);
		await shutdownSubsystems(handles);
		handles = null;
	});
}
