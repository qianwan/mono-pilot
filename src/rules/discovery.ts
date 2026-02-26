import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export const RULES_RELATIVE_DIR = join(".pi", "rules");

/** List *.rule.txt full paths from a directory, sorted. Returns empty array if directory is missing. */
export async function listRuleFiles(dirPath: string): Promise<string[]> {
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

export interface DiscoveredRules {
	/** User rules (~/.pi/rules/) not shadowed by a same-name project rule. */
	userRules: string[];
	/** Project rules (.pi/rules/); project wins on filename collision. */
	projectRules: string[];
}

/**
 * Discover rule files from project (.pi/rules/) and user (~/.pi/rules/) directories.
 * Project rules take priority: a user rule with the same basename is excluded.
 */
export async function discoverRules(cwd: string): Promise<DiscoveredRules> {
	const projectDir = resolve(cwd, RULES_RELATIVE_DIR);
	const userDir = resolve(homedir(), RULES_RELATIVE_DIR);

	const [projectFiles, userFiles] = await Promise.all([listRuleFiles(projectDir), listRuleFiles(userDir)]);

	// Project rules are processed first so they claim seenNames → user duplicates are dropped
	const seenNames = new Set<string>();
	const dedupeByName = (files: string[]) =>
		files.filter((filePath) => {
			const name = basename(filePath, ".rule.txt");
			if (seenNames.has(name)) return false;
			seenNames.add(name);
			return true;
		});

	const projectRules = dedupeByName(projectFiles);
	const userRules = dedupeByName(userFiles);

	return { userRules, projectRules };
}
