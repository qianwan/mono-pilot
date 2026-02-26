import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { hasMessageEntries } from "./mode-runtime.js";
import { isServerEnabled, loadMcpConfig } from "../mcp/config.js";
import type { McpConfigScope } from "../mcp/config.js";
import { toNonEmptyString } from "../mcp/config.js";
import { discoverRules } from "../rules/discovery.js";

const SESSION_HINTS_MESSAGE_TYPE = "SessionHints";
const MONO_PILOT_NAME = "mono-pilot";
const MAX_VERSION_SEARCH_DEPTH = 6;

let cachedVersion: string | null = null;

interface SessionHintsDetails {
	userRules: string[];
	projectRules: string[];
	userMcpServers: McpServerEntry[];
	projectMcpServers: McpServerEntry[];
}

interface McpServerEntry {
	name: string;
	url?: string;
}

async function discoverMcpServers(
	cwd: string,
): Promise<Pick<SessionHintsDetails, "userMcpServers" | "projectMcpServers">> {
	let config;
	try {
		config = await loadMcpConfig(cwd);
	} catch {
		return { userMcpServers: [], projectMcpServers: [] };
	}
	if (!config) return { userMcpServers: [], projectMcpServers: [] };

	const groups: { user: McpServerEntry[]; project: McpServerEntry[] } = { user: [], project: [] };

	for (const [serverName, serverConfig] of Object.entries(config.servers)) {
		if (!isServerEnabled(serverConfig)) continue;
		const source = config.sourceByServer[serverName];
		if (!source) continue;
		groups[source.scope].push({ name: serverName, url: toNonEmptyString(serverConfig.url) });
	}

	for (const servers of Object.values(groups)) {
		servers.sort((a, b) => a.name.localeCompare(b.name));
	}

	return {
		userMcpServers: groups.user,
		projectMcpServers: groups.project,
	};
}

function shortenHome(filePath: string): string {
	const home = homedir();
	if (filePath.startsWith(home)) {
		return `~${filePath.slice(home.length)}`;
	}
	return filePath;
}

function findPackageJsonPath(): string | undefined {
	let currentDir = dirname(fileURLToPath(import.meta.url));
	for (let depth = 0; depth < MAX_VERSION_SEARCH_DEPTH; depth += 1) {
		const candidate = resolve(currentDir, "package.json");
		if (existsSync(candidate)) return candidate;
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}
	return undefined;
}

function getMonoPilotVersion(): string | undefined {
	if (cachedVersion !== null) return cachedVersion || undefined;

	try {
		const packageJsonPath = findPackageJsonPath();
		if (!packageJsonPath) {
			cachedVersion = "";
			return undefined;
		}
		const raw = readFileSync(packageJsonPath, "utf8");
		const parsed = JSON.parse(raw) as { version?: unknown };
		cachedVersion = typeof parsed.version === "string" ? parsed.version : "";
	} catch {
		cachedVersion = "";
	}

	return cachedVersion || undefined;
}

export default function sessionHintsExtension(pi: ExtensionAPI) {
	// Render hints matching pi's native section style (same colors as [Context], [Skills], etc.)
	pi.registerMessageRenderer(SESSION_HINTS_MESSAGE_TYPE, (message, _options, theme) => {
		const details = message.details as SessionHintsDetails | undefined;
		const lines: string[] = [];
		const version = getMonoPilotVersion();
		const versionLabel = version ? ` v${version}` : "";

		lines.push(theme.bold(theme.fg("accent", MONO_PILOT_NAME)) + theme.fg("dim", versionLabel));
		lines.push(theme.fg("dim", "option+m") + theme.fg("muted", " to cycle Plan/Ask/Agent mode"));

		const userRules = details?.userRules ?? [];
		const projectRules = details?.projectRules ?? [];
		const userMcpServers = details?.userMcpServers ?? [];
		const projectMcpServers = details?.projectMcpServers ?? [];
		const hasRules = userRules.length > 0 || projectRules.length > 0;
		const hasMcp = userMcpServers.length > 0 || projectMcpServers.length > 0;

		if (hasRules || hasMcp) {
			lines.push("");
		}

		if (hasRules) {
			lines.push(theme.fg("mdHeading", "[Rules]"));

			if (userRules.length > 0) {
				lines.push(`  ${theme.fg("accent", "user")}`);
				for (const filePath of userRules) {
					lines.push(theme.fg("dim", `    ${shortenHome(filePath)}`));
				}
			}

			if (projectRules.length > 0) {
				lines.push(`  ${theme.fg("accent", "project")}`);
				for (const filePath of projectRules) {
					lines.push(theme.fg("dim", `    ${shortenHome(filePath)}`));
				}
			}
		}

		if (hasRules && hasMcp) {
			lines.push("");
		}

		if (hasMcp) {
			lines.push(theme.fg("mdHeading", "[MCP Servers]"));

			if (userMcpServers.length > 0) {
				lines.push(`  ${theme.fg("accent", "user")}`);
				for (const server of userMcpServers) {
					const urlPart = server.url ? `  ${theme.fg("muted", server.url)}` : "";
					lines.push(`    ${theme.fg("dim", server.name)}${urlPart}`);
				}
			}

			if (projectMcpServers.length > 0) {
				lines.push(`  ${theme.fg("accent", "project")}`);
				for (const server of projectMcpServers) {
					const urlPart = server.url ? `  ${theme.fg("muted", server.url)}` : "";
					lines.push(`    ${theme.fg("dim", server.name)}${urlPart}`);
				}
			}


		}

		return new Text(lines.join("\n"), 0, 0);
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		const entries = ctx.sessionManager.getEntries();
		if (hasMessageEntries(entries)) return;

		const [rulesDetails, mcpDetails] = await Promise.all([
			discoverRules(ctx.cwd),
			discoverMcpServers(ctx.cwd),
		]);
		const details: SessionHintsDetails = {
			...rulesDetails,
			...mcpDetails,
		};

		pi.sendMessage(
			{
				customType: SESSION_HINTS_MESSAGE_TYPE,
				content: "",
				display: true,
				details,
			},
			{ triggerTurn: false },
		);
	});
}
