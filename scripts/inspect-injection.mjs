import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_SNIPPET_LENGTH = 4000;

function parseArgs(argv) {
	const args = new Set(argv);
	const queryArg = argv.find((arg) => arg.startsWith("--query="));
	return {
		full: args.has("--full"),
		json: args.has("--json"),
		query: queryArg ? queryArg.slice("--query=".length) : "Example user query",
	};
}

function snippet(text, full) {
	if (full || text.length <= DEFAULT_SNIPPET_LENGTH) return text;
	return `${text.slice(0, DEFAULT_SNIPPET_LENGTH)}\n...`;
}

function printSection(title, body) {
	const divider = "=".repeat(Math.max(12, title.length));
	return `${divider}\n${title}\n${divider}\n${body}\n`;
}


class InspectionApi {
	constructor() {
		this.tools = [];
		this.handlers = new Map();
		this.appendedEntries = [];
	}

	registerTool(tool) {
		this.tools.push(tool);
	}

	registerFlag() {}

	registerCommand() {}

	registerShortcut() {}

	getFlag() {
		return undefined;
	}

	getActiveTools() {
		return this.tools.map((tool) => tool.name);
	}

	getAllTools() {
		return this.tools;
	}

	on(eventName, handler) {
		const list = this.handlers.get(eventName) ?? [];
		list.push(handler);
		this.handlers.set(eventName, list);
	}

	appendEntry(type, data) {
		this.appendedEntries.push({ type, data });
	}
}

async function loadExtension(modulePath) {
	const mod = await import(pathToFileURL(modulePath).href);
	return mod.default;
}

async function buildBaseSystemPrompt() {
	const projectContextPath = resolve("AGENTS.md");
	let projectContext = "Project-specific instructions were not provided.";
	if (existsSync(projectContextPath)) {
		projectContext = (await readFile(projectContextPath, "utf-8")).trim();
	}

	return {
		projectContextPath,
		basePrompt: [
			"# Project Context",
			projectContext,
			"",
			`Current date and time: ${new Date().toString()}`,
			`Current working directory: ${process.cwd()}`,
		].join("\n"),
	};
}

async function run() {
	const { full, json, query } = parseArgs(process.argv.slice(2));
	const distDir = resolve("dist");
	const monoPilotPath = resolve(distDir, "src", "extensions", "mono-pilot.js");

	if (!existsSync(monoPilotPath)) {
		throw new Error(
			`Missing ${monoPilotPath}. Run "npm run build" before inspecting prompt injection.`,
		);
	}

	const api = new InspectionApi();
	const monoPilotExtension = await loadExtension(monoPilotPath);
	monoPilotExtension(api);

	const beforeHandlers = api.handlers.get("before_agent_start") ?? [];
	const { basePrompt, projectContextPath } = await buildBaseSystemPrompt();
	let systemPrompt = basePrompt;
	for (const handler of beforeHandlers) {
		const result = handler({ systemPrompt });
		if (result?.systemPrompt) systemPrompt = result.systemPrompt;
	}

	const inputHandlers = api.handlers.get("input") ?? [];
	let runtimeEnvelope = query;
	for (const handler of inputHandlers) {
		const result = await handler({ text: runtimeEnvelope, images: [], source: "user" });
		if (result?.action === "transform" && typeof result.text === "string") {
			runtimeEnvelope = result.text;
		}
	}

	const result = {
		paths: {
			monoPilotExtension: monoPilotPath,
			projectContextPath,
		},
		tools: api.getActiveTools(),
		appendedEntries: api.appendedEntries,
		systemPrompt,
		runtimeEnvelope,
	};

	if (json) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}

	const output = [
		printSection("System Prompt", snippet(systemPrompt, full)),
		printSection("Runtime Envelope", snippet(runtimeEnvelope, full)),
	].join("\n");

	console.log(output);

	// No file output; always print to stdout.
}

run().catch((error) => {
	console.error("Failed to inspect injection:", error);
	process.exit(1);
});