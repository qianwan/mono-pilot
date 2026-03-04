import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import busSendExtension from "../../tools/bus-send.js";
import mailboxExtension from "../../tools/mailbox.js";
import readFileExtension from "../../tools/read-file.js";

export type GameToolName = "BusSend" | "MailBox" | "ReadFile";

interface GameToolDefinition {
	key: string;
	name: GameToolName;
	extension: ExtensionFactory;
}

const TOOL_REGISTRY: GameToolDefinition[] = [
	{ key: "bussend", name: "BusSend", extension: busSendExtension },
	{ key: "mailbox", name: "MailBox", extension: mailboxExtension },
	{ key: "readfile", name: "ReadFile", extension: readFileExtension },
];

export function resolveGameToolExtensions(allowlist?: string[]): ExtensionFactory[] {
	if (!allowlist) {
		return TOOL_REGISTRY.map((tool) => tool.extension);
	}

	const normalized = allowlist.map((value) => normalizeToolName(value));
	const allowed = new Set(normalized.filter(Boolean));
	const selected = TOOL_REGISTRY.filter(
		(tool) => allowed.has(tool.key) || allowed.has(tool.name.toLowerCase()),
	);

	const known = new Set<string>([
		...TOOL_REGISTRY.map((tool) => tool.key),
		...TOOL_REGISTRY.map((tool) => tool.name.toLowerCase()),
	]);
	const unknown = normalized.filter((value) => value && !known.has(value));
	if (unknown.length > 0) {
		console.warn(`[mono-game] unknown tools in profile: ${unknown.join(", ")}`);
	}

	return selected.map((tool) => tool.extension);
}

function normalizeToolName(value: string): string {
	return value.trim().toLowerCase();
}