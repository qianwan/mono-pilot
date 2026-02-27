import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { deriveAgentId, getAgentBriefDir } from "./paths.js";
import { parseFrontmatter } from "./frontmatter.js";
import { ensureDefaults } from "./defaults.js";

interface CollectedFile {
	relativePath: string;
	body: string;
}

/** Recursively collect .md files under a directory, returning parsed body content. */
function collectMarkdownFiles(dir: string): CollectedFile[] {
	if (!existsSync(dir)) return [];

	const results: CollectedFile[] = [];

	function walk(currentDir: string): void {
		let entries;
		try {
			entries = readdirSync(currentDir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			const fullPath = join(currentDir, entry.name);
			if (entry.isDirectory()) {
				walk(fullPath);
			} else if (entry.name.endsWith(".md")) {
				try {
					const raw = readFileSync(fullPath, "utf-8");
					const { body } = parseFrontmatter(raw);
					const trimmed = body.trim();
					if (trimmed.length > 0) {
						results.push({ relativePath: relative(dir, fullPath), body: trimmed });
					}
				} catch {
					// skip unreadable files
				}
			}
		}
	}

	walk(dir);
	return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function buildSection(heading: string, pathHint: string, files: CollectedFile[]): string {
	if (files.length === 0) return "";
	const lines = [`## ${heading}  [${pathHint}]`];
	for (const f of files) {
		lines.push(`### ${f.relativePath}`);
		lines.push(f.body);
	}
	return lines.join("\n");
}

const BRIEF_GUIDELINE =
	"When applying this brief in responses, integrate it naturally — like a colleague who recalls shared context. " +
	'Never draw attention to the brief system itself or use phrases like "I remember that..." — just use what you know seamlessly.';

const BRIEF_CHECK =
	"Review this conversation for information worth storing in your brief. " +
	"Update silently (no confirmation needed) via brief_write if you learned:\n" +
	"- **User info**: Name, role, preferences, working style, current goals\n" +
	"- **Project details**: Architecture, patterns, gotchas, dependencies, conventions\n" +
	"- **Corrections**: User corrected you or clarified something important\n" +
	"- **Preferences**: How they want you to behave, communicate, or approach tasks\n\n" +
	'Ask yourself: "If I started a new session tomorrow, what from this conversation would I want to remember?" ' +
	"If the answer is meaningful, update the appropriate brief file(s) now.";

/**
 * Read all core brief files and build the <brief> block for system prompt injection.
 * Creates default template files if they don't exist yet.
 */
export function buildBriefBlock(cwd: string): string {
	const agentId = deriveAgentId(cwd);
	ensureDefaults(agentId);

	const briefDir = getAgentBriefDir(agentId);

	const sections: string[] = [];

	const humanSection = buildSection(
		"User Context",
		`~/.mono-pilot/agents/${agentId}/brief/human/`,
		collectMarkdownFiles(join(briefDir, "human")),
	);
	if (humanSection) sections.push(humanSection);

	const projectSection = buildSection(
		"Project Context",
		`~/.mono-pilot/agents/${agentId}/brief/project/`,
		collectMarkdownFiles(join(briefDir, "project")),
	);
	if (projectSection) sections.push(projectSection);

	const tasksSection = buildSection(
		"Current Tasks",
		`~/.mono-pilot/agents/${agentId}/brief/tasks/`,
		collectMarkdownFiles(join(briefDir, "tasks")),
	);
	if (tasksSection) sections.push(tasksSection);

	if (sections.length === 0) return "";

	return `<brief>\n${sections.join("\n\n")}\n\n${BRIEF_GUIDELINE}\n\n${BRIEF_CHECK}\n</brief>`;
}