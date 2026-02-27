import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { deriveAgentId, resolveBriefPath } from "../src/brief/paths.js";
import { countBodyLines, parseFrontmatter, serializeWithFrontmatter } from "../src/brief/frontmatter.js";

const DESCRIPTION =
	"Write content to a brief file in the current agent's brief directory " +
	"(~/.mono-pilot/agents/<agent-id>/brief/). " +
	"The brief is injected into your system prompt as the <brief> block — update it when you learn something worth remembering.\n" +
	"Common paths: human/identity.md (who the user is), human/prefs/*.md (communication, coding style), " +
	"project/overview.md, project/conventions.md, project/commands.md, project/gotchas.md, tasks/current.md.\n" +
	"Preserves YAML frontmatter (description, limit). Validates body does not exceed the file's line limit. " +
	"Creates the file with default frontmatter if it does not exist.";

const DEFAULT_LIMIT = 50;
const DEFAULT_DESCRIPTION = "Agent-created brief file.";

const briefWriteSchema = Type.Object({
	path: Type.String({
		description: 'Relative path within the brief directory (e.g. "human/prefs/communication.md", "project/gotchas.md")',
	}),
	content: Type.String({
		description: "The body content to write (without frontmatter). Frontmatter is preserved automatically.",
	}),
	mode: Type.Optional(
		Type.Union([Type.Literal("overwrite"), Type.Literal("append")], {
			description: 'Write mode: "overwrite" replaces body, "append" adds to end. Default: "overwrite"',
		}),
	),
});

type BriefWriteInput = Static<typeof briefWriteSchema>;

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "BriefWrite",
		label: "BriefWrite",
		description: DESCRIPTION,
		parameters: briefWriteSchema,
		async execute(_toolCallId, params: BriefWriteInput, _signal, _onUpdate, ctx) {
			const agentId = deriveAgentId(ctx.cwd);
			const writeMode = params.mode ?? "overwrite";
			const filePath = resolveBriefPath(params.path, agentId);

			let frontmatter = { description: DEFAULT_DESCRIPTION, limit: DEFAULT_LIMIT };
			let existingBody = "";

			if (existsSync(filePath)) {
				try {
					const raw = readFileSync(filePath, "utf-8");
					const parsed = parseFrontmatter(raw);
					frontmatter = {
						description: parsed.frontmatter.description ?? DEFAULT_DESCRIPTION,
						limit: parsed.frontmatter.limit ?? DEFAULT_LIMIT,
					};
					existingBody = parsed.body;
				} catch {
					// Fall through with defaults
				}
			}

			const newBody = writeMode === "append"
				? (existingBody.trim() + "\n" + params.content).trim()
				: params.content.trim();

			const lineCount = countBodyLines(newBody);
			if (lineCount > frontmatter.limit) {
				return {
					content: [{
						type: "text",
						text: `Rejected: content has ${lineCount} lines but file limit is ${frontmatter.limit}. ` +
							`Condense the content or increase the limit in frontmatter.`,
					}],
					details: { status: "limit_exceeded", path: params.path, agentId, lineCount, limit: frontmatter.limit },
				};
			}

			try {
				const dir = dirname(filePath);
				mkdirSync(dir, { recursive: true });
				writeFileSync(filePath, serializeWithFrontmatter(frontmatter, newBody), "utf-8");
				return {
					content: [{ type: "text", text: `Written ${lineCount} lines to ${params.path} (agent: ${agentId})` }],
					details: { status: "ok", path: params.path, agentId, lineCount },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Error writing brief file: ${message}` }],
					details: { status: "error", path: params.path, agentId, error: message },
				};
			}
		},
	});
}
