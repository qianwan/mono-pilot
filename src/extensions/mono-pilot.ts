import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { onCompaction } from "../brief/reflection.js";
import shellExtension from "../../tools/shell.js";
import globExtension from "../../tools/glob.js";
import rgExtension from "../../tools/rg.js";
import readFileExtension from "../../tools/read-file.js";
import deleteExtension from "../../tools/delete.js";
import semanticSearchExtension from "../../tools/semantic-search.js";
import webSearchExtension from "../../tools/web-search.js";
import webFetchExtension from "../../tools/web-fetch.js";
import askQuestionExtension from "../../tools/ask-question.js";
import subagentExtension from "../../tools/subagent.js";
import listMcpResourcesExtension from "../../tools/list-mcp-resources.js";
import fetchMcpResourceExtension from "../../tools/fetch-mcp-resource.js";
import listMcpToolsExtension from "../../tools/list-mcp-tools.js";
import callMcpToolExtension from "../../tools/call-mcp-tool.js";
import switchModeExtension from "../../tools/switch-mode.js";
import applyPatchExtension from "../../tools/apply-patch.js";
import userMessageExtension from "./user-message.js";
import systemPromptExtension from "./system-prompt.js";
import sessionHintsExtension from "./session-hints.js";
import lspDiagnosticsExtension from "../../tools/lsp-diagnostics.js";
import lspSymbolsExtension from "../../tools/lsp-symbols.js";
import { LSP } from "../lsp/index.js";
import briefWriteExtension from "../../tools/brief-write.js";

const toolExtensions: ExtensionFactory[] = [
	shellExtension,
	globExtension,
	rgExtension,
	readFileExtension,
	deleteExtension,
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
];

export default function monoPilotExtension(pi: ExtensionAPI) {
	for (const register of toolExtensions) {
		register(pi);
	}

	pi.on("session_start", async (_event, ctx) => {
		LSP.init(ctx.cwd);
	});

	pi.on("session_compact", async () => {
		onCompaction();
	});
}
