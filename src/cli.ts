#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_TOOLS = "ls";
const TOOL_BLACKLIST = new Set(["edit", "write", "grep", "read", "glob", "bash"]);

function hasFlag(args: string[], names: string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (names.includes(arg)) return true;
		for (const name of names) {
			if (arg.startsWith(`${name}=`)) return true;
		}
	}
	return false;
}

function sanitizeToolList(rawValue: string): string {
	const tools = rawValue
		.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean)
		.filter((tool) => !TOOL_BLACKLIST.has(tool));

	if (tools.length === 0) {
		return DEFAULT_TOOLS;
	}
	return Array.from(new Set(tools)).join(",");
}

function sanitizeToolsArgs(args: string[]): string[] {
	const sanitized: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--tools") {
			const raw = args[i + 1] ?? "";
			sanitized.push("--tools", sanitizeToolList(raw));
			i++;
			continue;
		}
		if (arg.startsWith("--tools=")) {
			const raw = arg.slice("--tools=".length);
			sanitized.push(`--tools=${sanitizeToolList(raw)}`);
			continue;
		}
		sanitized.push(arg);
	}
	return sanitized;
}

function resolveExtensionPath(here: string): string {
	const candidates = [
		resolve(here, "extensions", "mono-pilot.js"),
		resolve(here, "extensions", "mono-pilot.ts"),
	];

	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}

	// Fallback keeps previous behavior even if file is unexpectedly missing.
	return candidates[0];
}

function buildPiArgs(userArgs: string[]): string[] {
	const here = dirname(fileURLToPath(import.meta.url));
	const extensionPath = resolveExtensionPath(here);
	const sanitizedUserArgs = sanitizeToolsArgs(userArgs);

	const args: string[] = ["--no-extensions", "--extension", extensionPath];
	if (!hasFlag(sanitizedUserArgs, ["--tools", "--no-tools"])) {
		args.push("--tools", DEFAULT_TOOLS);
	}
	return [...args, ...sanitizedUserArgs];
}

function resolvePiCliPath(): string {
	const codingAgentEntryUrl = import.meta.resolve("@mariozechner/pi-coding-agent");
	const codingAgentEntryPath = fileURLToPath(codingAgentEntryUrl);
	return resolve(dirname(codingAgentEntryPath), "cli.js");
}

function main() {
	const userArgs = process.argv.slice(2);
	const piArgs = buildPiArgs(userArgs);
	const piCliPath = resolvePiCliPath();

	const child = spawn(process.execPath, [piCliPath, ...piArgs], {
		stdio: "inherit",
		env: process.env,
	});

	child.on("exit", (code, signal) => {
		if (signal) {
			process.kill(process.pid, signal);
			return;
		}
		process.exit(code ?? 1);
	});

	child.on("error", (error) => {
		console.error(`[mono-pilot] Failed to launch pi: ${error.message}`);
		process.exit(1);
	});
}

main();
