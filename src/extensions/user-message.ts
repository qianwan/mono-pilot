import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	buildRuntimeEnvelope,
	createModeStateData,
	modeRuntimeStore,
	MODE_STATE_ENTRY_TYPE,
	ASK_MODE_SWITCH_REMINDER,
	PLAN_MODE_STILL_ACTIVE_REMINDER,
	type ModeStateSnapshot,
} from "./mode-runtime.js";
import { getBriefReflectionReminder } from "../brief/reflection.js";
import {
	createRpcRequestId,
	postJsonRpcRequest,
	MCP_PROTOCOL_VERSION,
	MCP_CLIENT_NAME,
	MCP_CLIENT_VERSION,
} from "../mcp/protocol.js";
import {
	extractStringHeaders,
	isRecord,
	isServerEnabled,
	loadMcpConfig,
	toNonEmptyString,
} from "../mcp/config.js";
import { discoverRules } from "../rules/discovery.js";

const PLAN_MODE_REMINDER_PATH = fileURLToPath(new URL("../../tools/plan-mode-reminder.md", import.meta.url));
const ASK_MODE_REMINDER_PATH = fileURLToPath(new URL("../../tools/ask-mode-reminder.md", import.meta.url));
const MCP_INSTRUCTIONS_DESCRIPTION = "Instructions provided by MCP servers to help use them properly";
const USER_QUERY_RENDER_PATCH_FLAG = "__monoPilotUserQueryRenderPatched__";
const USER_MESSAGE_MODULE_PATH = fileURLToPath(import.meta.url);

const CURRENT_DATE_TIME_REMINDER_PREFIX = "Current date and time:";

const DEV_RUNTIME_TOOL_EFFICIENCY_REMINDER = `<system_reminder>
Detected development runtime (extension loaded from src/*.ts with runtime transpilation).
Always keep the current task goal first; only focus on tool-usage efficiency when the task is blocked or clear inefficiency appears.
When inefficiency is directly related to the current task, tool changes are allowed, but must be incremental: add observability/visibility first, then apply the smallest necessary logic adjustment.
Keep changes scoped, avoid unrelated refactors, and keep behavior verifiable; run npm run check after edits (and run npm run build when src changes).
If user intent or change boundaries are unclear, ask before modifying.
</system_reminder>`;

interface ServerInstructions {
	server: string;
	instructions: string;
}

function extractUserQueryForTuiDisplay(text: string): string {
	const startIndex = text.indexOf("<user_query>");
	if (startIndex === -1) return text;

	const contentStart = startIndex + 12; // length of "<user_query>"
	const endIndex = text.lastIndexOf("</user_query>");
	if (endIndex === -1 || endIndex <= contentStart) return text;

	const extracted = text.slice(contentStart, endIndex).trim();
	return extracted || text;
}

async function patchInteractiveModeUserMessageDisplay(): Promise<void> {
	try {
		const packageEntryUrl = import.meta.resolve("@mariozechner/pi-coding-agent");
		const packageEntryPath = fileURLToPath(packageEntryUrl);
		const interactiveModePath = resolve(dirname(packageEntryPath), "modes", "interactive", "interactive-mode.js");
		const interactiveModeModule = (await import(pathToFileURL(interactiveModePath).href)) as {
			InteractiveMode?: { prototype?: Record<string, unknown> };
		};

		const prototype = interactiveModeModule.InteractiveMode?.prototype;
		if (!prototype) return;
		if (prototype[USER_QUERY_RENDER_PATCH_FLAG]) return;

		const originalGetUserMessageText = prototype.getUserMessageText;
		if (typeof originalGetUserMessageText !== "function") return;

		prototype.getUserMessageText = function patchedGetUserMessageText(message: unknown): string {
			const original = String(
				(originalGetUserMessageText as (this: unknown, message: unknown) => string).call(this, message) ?? "",
			);
			return extractUserQueryForTuiDisplay(original);
		};

		prototype[USER_QUERY_RENDER_PATCH_FLAG] = true;
	} catch {
		// Best effort: keep default user message rendering if internals change.
	}
}

function normalizeServerLabel(value: string): string | undefined {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length === 0) return undefined;
	return normalized;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function buildPlanFileReminder(planFilePath: string): string {
	const escapedPath = escapeXml(planFilePath);
	return [
		"<system_reminder>",
		`Plan file path: ${escapedPath}`,
		"While Plan mode is active, create or update this plan file as needed during collaboration with the user.",
		"You may modify this plan file in Plan mode; do not modify other files unless the mode changes.",
		"</system_reminder>",
	].join("\n");
}

function appendPlanFileReminder(reminder: string | undefined, snapshot: ModeStateSnapshot): string | undefined {
	if (snapshot.activeMode !== "plan") {
		return reminder;
	}

	const planFilePath = snapshot.planFilePath?.trim();
	if (!planFilePath) {
		return reminder;
	}

	const planFileReminder = buildPlanFileReminder(planFilePath);
	if (!reminder) {
		return planFileReminder;
	}

	return `${reminder}\n\n${planFileReminder}`;
}

function isDevRuntimeModulePath(modulePath: string): boolean {
	const normalized = modulePath.replace(/\\/g, "/");
	return normalized.includes("/src/") && normalized.endsWith(".ts");
}

function appendDevRuntimeToolEfficiencyReminder(reminder: string | undefined): string | undefined {
	if (!isDevRuntimeModulePath(USER_MESSAGE_MODULE_PATH)) {
		return reminder;
	}

	if (!reminder) {
		return DEV_RUNTIME_TOOL_EFFICIENCY_REMINDER;
	}

	return `${reminder}\n\n${DEV_RUNTIME_TOOL_EFFICIENCY_REMINDER}`;
}

function buildCurrentDateTimeReminder(now: Date = new Date()): string {
	return `<system_reminder>\n${CURRENT_DATE_TIME_REMINDER_PREFIX} ${now.toString()}\n</system_reminder>`;
}

function appendCurrentDateTimeReminder(reminder: string | undefined, now: Date = new Date()): string {
	const dateTimeReminder = buildCurrentDateTimeReminder(now);
	if (!reminder) {
		return dateTimeReminder;
	}
	return `${reminder}\n\n${dateTimeReminder}`;
}

async function fetchServerInstructions(
	serverUrl: string,
	serverHeaders: Record<string, string>,
	serverName: string,
): Promise<string | undefined> {
	try {
		const initializeResponse = await postJsonRpcRequest({
			url: serverUrl,
			headers: serverHeaders,
			body: {
				jsonrpc: "2.0",
				id: createRpcRequestId(`runtime-envelope:${serverName}:initialize`),
				method: "initialize",
				params: {
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: {
						name: MCP_CLIENT_NAME,
						version: MCP_CLIENT_VERSION,
					},
				},
			},
			parentSignal: undefined,
			expectResponseBody: true,
			timeoutMs: 4_000,
		});

		const initializeBody = initializeResponse.parsedBody;
		if (!initializeBody || initializeBody.error || !isRecord(initializeBody.result)) {
			return undefined;
		}

		return toNonEmptyString(initializeBody.result.instructions);
	} catch {
		return undefined;
	}
}

async function buildMcpInstructionsEnvelope(workspaceCwd: string): Promise<string | undefined> {
	let config;
	try {
		config = await loadMcpConfig(workspaceCwd);
	} catch {
		return undefined;
	}
	if (!config) return undefined;

	const serverEntries = Object.entries(config.servers)
		.filter(([, config]) => isServerEnabled(config))
		.map(([name, config]) => {
			const serverName = normalizeServerLabel(name);
			const serverUrl = toNonEmptyString(config.url);
			if (!serverName || !serverUrl) return undefined;

			return {
				serverName,
				serverUrl,
				headers: extractStringHeaders(config.headers),
			};
		})
		.filter(
			(entry): entry is { serverName: string; serverUrl: string; headers: Record<string, string> } =>
				entry !== undefined,
		)
		.sort((a, b) => a.serverName.localeCompare(b.serverName));

	if (serverEntries.length === 0) return undefined;

	const instructionResults = await Promise.all(
		serverEntries.map(async (entry): Promise<ServerInstructions | undefined> => {
			const instructions = await fetchServerInstructions(entry.serverUrl, entry.headers, entry.serverName);
			if (!instructions) return undefined;
			return {
				server: entry.serverName,
				instructions,
			};
		}),
	);

	const instructions = instructionResults.filter((entry): entry is ServerInstructions => entry !== undefined);
	if (instructions.length === 0) return undefined;

	const lines: string[] = [
		`<mcp_instructions description="${MCP_INSTRUCTIONS_DESCRIPTION}">`,
	];

	for (let index = 0; index < instructions.length; index++) {
		const instruction = instructions[index];
		if (index > 0) lines.push("");
		lines.push(`Server: ${instruction.server}`);
		lines.push(instruction.instructions);
	}

	lines.push("</mcp_instructions>");
	return lines.join("\n");
}

async function buildRulesEnvelope(workspaceCwd: string): Promise<string | undefined> {
	const { userRules, projectRules } = await discoverRules(workspaceCwd);
	const allRulePaths = [...userRules, ...projectRules];
	if (allRulePaths.length === 0) return undefined;

	const ruleEntries: Array<{ filename: string; content: string }> = [];
	for (const filePath of allRulePaths) {
		try {
			const content = await readFile(filePath, "utf-8");
			const normalized = content.trim();
			if (normalized.length > 0) {
				ruleEntries.push({ filename: basename(filePath), content: normalized });
			}
		} catch {
			// Ignore unreadable rule files.
		}
	}

	if (ruleEntries.length === 0) return undefined;

	const rules = ruleEntries.sort((a, b) => a.filename.localeCompare(b.filename)).map((e) => e.content);
	const lines: string[] = ["<rules>"];
	for (const rule of rules) {
		lines.push("<user_rule>");
		lines.push(rule);
		lines.push("</user_rule>");
	}
	lines.push("</rules>");

	return lines.join("\n");
}

export default function runtimeEnvelopeExtension(pi: ExtensionAPI) {
	void patchInteractiveModeUserMessageDisplay();

	let planModeReminderCache: string | null | undefined;
	let askModeReminderCache: string | null | undefined;
	let mcpInstructionsCache: string | null | undefined;
	let rulesEnvelopeCache: string | null | undefined;
	let mcpInstructionsPending: Promise<string | undefined> | undefined;
	let rulesEnvelopePending: Promise<string | undefined> | undefined;
	const workspaceCwd = process.cwd();

	const getPlanEntryReminder = async (): Promise<string> => {
		if (planModeReminderCache !== undefined) {
			return planModeReminderCache ?? PLAN_MODE_STILL_ACTIVE_REMINDER;
		}
		try {
			const content = await readFile(PLAN_MODE_REMINDER_PATH, "utf-8");
			planModeReminderCache = content.trim();
			return planModeReminderCache;
		} catch {
			planModeReminderCache = null;
			return PLAN_MODE_STILL_ACTIVE_REMINDER;
		}
	};

	const getAskEntryReminder = async (): Promise<string> => {
		if (askModeReminderCache !== undefined) {
			return askModeReminderCache ?? ASK_MODE_SWITCH_REMINDER;
		}
		try {
			const content = await readFile(ASK_MODE_REMINDER_PATH, "utf-8");
			askModeReminderCache = content.trim();
			return askModeReminderCache || ASK_MODE_SWITCH_REMINDER;
		} catch {
			askModeReminderCache = null;
			return ASK_MODE_SWITCH_REMINDER;
		}
	};

	const getMcpInstructions = async (): Promise<string | undefined> => {
		if (mcpInstructionsCache !== undefined) {
			return mcpInstructionsCache ?? undefined;
		}

		if (!mcpInstructionsPending) {
			mcpInstructionsPending = buildMcpInstructionsEnvelope(workspaceCwd)
				.then((instructions) => {
					mcpInstructionsCache = instructions ?? null;
					return instructions;
				})
				.catch(() => {
					mcpInstructionsCache = null;
					return undefined;
				})
				.finally(() => {
					mcpInstructionsPending = undefined;
				});
		}

		return mcpInstructionsPending;
	};

	const getRulesEnvelope = async (): Promise<string | undefined> => {
		if (rulesEnvelopeCache !== undefined) {
			return rulesEnvelopeCache ?? undefined;
		}

		if (!rulesEnvelopePending) {
			rulesEnvelopePending = buildRulesEnvelope(workspaceCwd)
				.then((rulesEnvelope) => {
					rulesEnvelopeCache = rulesEnvelope ?? null;
					return rulesEnvelope;
				})
				.catch(() => {
					rulesEnvelopeCache = null;
					return undefined;
				})
				.finally(() => {
					rulesEnvelopePending = undefined;
				});
		}

		return rulesEnvelopePending;
	};

	// Eagerly pre-fetch rules and MCP instructions in the background so the first input isn't delayed
	getRulesEnvelope().catch(() => {});
	getMcpInstructions().catch(() => {});
	getAskEntryReminder().catch(() => {});

	pi.on("input", async (event) => {
		if (event.source === "extension") return;

		const [planEntryReminder, askEntryReminder, mcpInstructions, rulesEnvelope] = await Promise.all([
			getPlanEntryReminder(),
			getAskEntryReminder(),
			getMcpInstructions(),
			getRulesEnvelope(),
		]);
		const { reminder, changed, snapshot } = modeRuntimeStore.consumeReminder(
			planEntryReminder,
			askEntryReminder,
		);
		const reminderWithPlanFile = appendPlanFileReminder(reminder, snapshot);
		const reminderWithDevToolEfficiency = appendDevRuntimeToolEfficiencyReminder(reminderWithPlanFile);
		const reminderWithCurrentDateTime = appendCurrentDateTimeReminder(reminderWithDevToolEfficiency);
		if (changed) {
			pi.appendEntry(MODE_STATE_ENTRY_TYPE, createModeStateData(snapshot));
		}

		const briefReminder = getBriefReflectionReminder();

		return {
			action: "transform",
			text: buildRuntimeEnvelope(
				event.text,
				reminderWithCurrentDateTime,
				mcpInstructions,
				rulesEnvelope,
				briefReminder,
			),
			images: event.images,
		};
	});
}
