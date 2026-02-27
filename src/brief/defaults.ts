import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentBriefDir } from "./paths.js";

interface DefaultTemplate {
	description: string;
	limit: number;
	content: string;
}

const DEFAULTS: Record<string, DefaultTemplate> = {
	"human/identity.md": {
		description: "What I know about the person I'm working with. Update when learning about their background, role, or identity.",
		limit: 40,
		content: "I haven't gotten to know this person yet.",
	},
	"human/prefs/communication.md": {
		description: "How this person prefers to communicate. Update when they express language, verbosity, or style preferences.",
		limit: 30,
		content: "No communication preferences learned yet.",
	},
	"human/prefs/coding-style.md": {
		description: "Coding conventions and style preferences. Update when they show patterns in naming, formatting, or tooling choices.",
		limit: 30,
		content: "No coding style preferences learned yet.",
	},
	"project/overview.md": {
		description: "High-level understanding of this project. Update after exploring the codebase structure, tech stack, and architecture.",
		limit: 50,
		content: "I'm still getting to know this codebase.\nIf there's an AGENTS.md, CLAUDE.md, or README, I should read it early.",
	},
	"project/commands.md": {
		description: "Build, test, lint, and run commands. Update when discovering or confirming project commands.",
		limit: 30,
		content: "No commands discovered yet.",
	},
	"project/conventions.md": {
		description: "Code conventions, commit style, and recurring patterns. Update when observing how this project does things.",
		limit: 40,
		content: "No conventions learned yet.",
	},
	"project/gotchas.md": {
		description: "Known pitfalls, warnings, and surprising behavior. Update when hitting unexpected issues.",
		limit: 40,
		content: "No gotchas discovered yet.",
	},
	"tasks/current.md": {
		description: "Current task progress and status. Update when starting, progressing, or completing tasks.",
		limit: 50,
		content: "No active tasks.",
	},
};

function writeDefaultFile(baseDir: string, relativePath: string, template: DefaultTemplate): void {
	const filePath = join(baseDir, relativePath);
	if (existsSync(filePath)) return;

	const dir = dirname(filePath);
	mkdirSync(dir, { recursive: true });

	const content = `---\ndescription: ${template.description}\nlimit: ${template.limit}\n---\n${template.content}\n`;
	writeFileSync(filePath, content, "utf-8");
}

export function ensureDefaults(agentId: string): void {
	const dir = getAgentBriefDir(agentId);
	for (const [path, template] of Object.entries(DEFAULTS)) {
		writeDefaultFile(dir, path, template);
	}
}