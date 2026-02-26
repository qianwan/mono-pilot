import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { hasMessageEntries } from "./mode-runtime.js";

const SESSION_HINTS_MESSAGE_TYPE = "MonoPilot";
const RULES_RELATIVE_DIR = join(".pi", "rules");

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

/** Build a compact session-start hints string. */
async function buildHintsContent(cwd: string): Promise<string> {
	const lines: string[] = [];

	// 1. Rules files
	const workspaceRulesDir = resolve(cwd, RULES_RELATIVE_DIR);
	const userRulesDir = resolve(homedir(), RULES_RELATIVE_DIR);

	const [workspaceRules, userRules] = await Promise.all([
		listRuleFiles(workspaceRulesDir),
		listRuleFiles(userRulesDir),
	]);

	if (userRules.length > 0 || workspaceRules.length > 0) {
		lines.push("");
		lines.push("[Rules]");

		if (userRules.length > 0) {
			lines.push("  user");
			for (const filePath of userRules) {
				lines.push(`    ${shortenHome(filePath)}`);
			}
		}

		if (workspaceRules.length > 0) {
			lines.push("  project");
			for (const filePath of workspaceRules) {
				lines.push(`    ${shortenHome(filePath)}`);
			}
		}
	}

	// 2. Mode switch hint
	if (lines.length > 0) lines.push("");
	lines.push("Mode switch: use `option+m` to toggle Plan/Ask/Agent mode.");

	return lines.join("\n");
}

function shortenHome(filePath: string): string {
	const home = homedir();
	if (filePath.startsWith(home)) {
		return `~${filePath.slice(home.length)}`;
	}
	return filePath;
}

export default function sessionHintsExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		const entries = ctx.sessionManager.getEntries();
		if (hasMessageEntries(entries)) return;

		const content = await buildHintsContent(ctx.cwd);

		pi.sendMessage(
			{
				customType: SESSION_HINTS_MESSAGE_TYPE,
				content,
				display: true,
			},
			{ triggerTurn: false },
		);
	});
}
