import type { ExtensionAPI, ToolInfo } from "@mariozechner/pi-coding-agent";
import { getGameChannel, getGameGmChannel, loadGameIdentity } from "./identity.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const NO_DESCRIPTION_PLACEHOLDER = "No short description provided.";
const AVAILABLE_TOOLS_TOKEN = "{{AVAILABLE_TOOLS_BULLETS}}";
const DISPLAY_NAME_TOKEN = "{{DISPLAY_NAME}}";
const IDENTITY_PROMPT_TOKEN = "{{IDENTITY_PROMPT}}";
const GAME_CHANNEL_TOKEN = "{{GAME_CHANNEL}}";
const GM_CHANNEL_TOKEN = "{{GM_CHANNEL}}";
const GAME_RULES_TOKEN = "{{GAME_RULES}}";
const ROLE_MANUAL_TOKEN = "{{ROLE_MANUAL}}";
const GAME_RULES_FILENAME = "游戏说明.md";
const ROLE_MANUAL_FILENAME = "角色手册.md";

interface GameDocs {
	gameRules?: string;
	roleManual?: string;
}

const GAME_SYSTEM_PROMPT_TEMPLATE = `You are a role-play agent in a multi-agent murder mystery simulation.

Agent identity:
- Display name: ${DISPLAY_NAME_TOKEN}

Core goal:
- Stay in character and advance the story coherently.
- Keep private knowledge private unless role rules allow disclosure.
- Use communication tools to coordinate with other agents in-world.

Behavior rules:
- Default to in-character responses.
- If the user gives an explicit out-of-character instruction, follow it directly.
- Prefer concise responses unless the user asks for long-form narration.
- Treat <bus_messages> as incoming in-world messages from other agents.
- Use BusSend to reply to other agents when needed.
- Check MailBox once for unread messages before taking action; avoid repeated checks.
- Strictly follow guidance received from the GM channel.
- The GM channel is receive-only; never send messages to it.

Channel subscriptions (explicit):
- \`${GAME_CHANNEL_TOKEN}\`: public message board (check MailBox).
- \`${GM_CHANNEL_TOKEN}\`: GM instructions (auto-injected into user message, receive-only).

Game rules:
${GAME_RULES_TOKEN}

Role manual:
${ROLE_MANUAL_TOKEN}

Character sheet:
${IDENTITY_PROMPT_TOKEN}

Available tools:
${AVAILABLE_TOOLS_TOKEN}`;

function getFirstDescriptionLine(description: string | undefined): string {
	if (!description) return NO_DESCRIPTION_PLACEHOLDER;

	for (const line of description.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length > 0) return trimmed;
	}

	return NO_DESCRIPTION_PLACEHOLDER;
}

function buildActiveToolBullets(activeToolNames: string[], allTools: ToolInfo[]): string {
	const activeSet = new Set(activeToolNames);
	const lines = allTools
		.filter((tool) => activeSet.has(tool.name))
		.map((tool) => `- ${tool.name}: ${getFirstDescriptionLine(tool.description)}`);

	return lines.length > 0 ? lines.join("\n") : "- (none)";
}

function loadGameDocs(workspaceCwd: string, displayName: string): GameDocs {
	const gameRoot = findGameRoot(workspaceCwd);
	if (!gameRoot) return {};

	return {
		gameRules: readText(resolve(gameRoot, GAME_RULES_FILENAME)),
		roleManual: readRoleManual(workspaceCwd),
	};
}

function findGameRoot(startDir: string): string | undefined {
	let current = resolve(startDir);
	for (;;) {
		if (existsSync(resolve(current, GAME_RULES_FILENAME))) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function readRoleManual(roleDir: string): string | undefined {
	return readText(resolve(roleDir, ROLE_MANUAL_FILENAME));
}

function readText(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const raw = readFileSync(path, "utf-8").trim();
		return raw.length > 0 ? raw : undefined;
	} catch {
		return undefined;
	}
}

export default function gameSystemPromptExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", (_event, ctx) => {
		const tools = buildActiveToolBullets(pi.getActiveTools(), pi.getAllTools());
		const identity = loadGameIdentity(ctx.cwd);
		const identityPrompt = identity.identityPrompt ?? "(missing .mono-game/identity.md)";
		const channelOverride = pi.getFlag("game-channel");
		const gameChannel = getGameChannel(
			ctx.cwd,
			typeof channelOverride === "string" ? channelOverride : undefined,
		);
		const gmChannel = getGameGmChannel(gameChannel);
		const docs = loadGameDocs(ctx.cwd, identity.displayName);
		const gameRules = docs.gameRules ?? "(missing 游戏说明.md)";
		const roleManual = docs.roleManual ?? "(missing 角色手册)";
		const gamePrompt = GAME_SYSTEM_PROMPT_TEMPLATE
			.split(AVAILABLE_TOOLS_TOKEN)
			.join(tools)
			.split(DISPLAY_NAME_TOKEN)
			.join(identity.displayName)
			.split(IDENTITY_PROMPT_TOKEN)
			.join(identityPrompt)
			.split(GAME_CHANNEL_TOKEN)
			.join(gameChannel)
			.split(GM_CHANNEL_TOKEN)
			.join(gmChannel)
			.split(GAME_RULES_TOKEN)
			.join(gameRules)
			.split(ROLE_MANUAL_TOKEN)
			.join(roleManual);
		try {
			writeFileSync(".mono-game/system-prompt.txt", gamePrompt, "utf-8");
		} catch (err) {
			console.warn("[mono-game] failed to write system prompt", String(err));
		}

		return { systemPrompt: gamePrompt };
	});
}
