import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { hasMessageEntries } from "./mode-runtime.js";

const SESSION_HINTS_MESSAGE_TYPE = "SessionHints";
const RULES_RELATIVE_DIR = join(".pi", "rules");
const MONO_PILOT_NAME = "mono-pilot";
const MAX_VERSION_SEARCH_DEPTH = 6;

let cachedVersion: string | null = null;

interface SessionHintsDetails {
	userRules: string[];
	projectRules: string[];
}

/** List *.rule.txt full paths from a directory (empty array if dir missing). */
async function listRuleFiles(dirPath: string): Promise<string[]> {
	if (!existsSync(dirPath)) return [];
	try {
		const entries = await readdir(dirPath, { withFileTypes: true, encoding: "utf8" });
		return entries
			.filter((e) => e.isFile() && e.name.endsWith(".rule.txt"))
			.map((e) => resolve(dirPath, e.name))
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}

/** Discover rules files grouped by scope, deduped by rule name. */
async function discoverRules(cwd: string): Promise<SessionHintsDetails> {
	const workspaceRulesDir = resolve(cwd, RULES_RELATIVE_DIR);
	const userRulesDir = resolve(homedir(), RULES_RELATIVE_DIR);

	const [workspaceRules, userRules] = await Promise.all([
		listRuleFiles(workspaceRulesDir),
		listRuleFiles(userRulesDir),
	]);

	const seenNames = new Set<string>();
	const dedupeByName = (rules: string[]) =>
		rules.filter((filePath) => {
			const name = basename(filePath, ".rule.txt");
			if (seenNames.has(name)) return false;
			seenNames.add(name);
			return true;
		});

	const uniqueWorkspaceRules = dedupeByName(workspaceRules);
	const uniqueUserRules = dedupeByName(userRules);

	return { userRules: uniqueUserRules, projectRules: uniqueWorkspaceRules };
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

		if (userRules.length > 0 || projectRules.length > 0) {
			lines.push("");
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

		return new Text(lines.join("\n"), 0, 0);
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		const entries = ctx.sessionManager.getEntries();
		if (hasMessageEntries(entries)) return;

		const details = await discoverRules(ctx.cwd);

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
