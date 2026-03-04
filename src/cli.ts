#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_TOOLS = "ls";
const MODE_GAME = "game";
const MODE_CODING = "coding";
const MODE_FLAG = "--mono-mode";
const GAME_CHANNEL_FLAG = "--game-channel";
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

function resolveExtensionPath(here: string, mode: string): string {
	const extensionFile = mode === MODE_GAME ? "mono-game" : "mono-pilot";
	const candidates = [
		resolve(here, "extensions", `${extensionFile}.js`),
		resolve(here, "extensions", `${extensionFile}.ts`),
	];

	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}

	// Fallback keeps previous behavior even if file is unexpectedly missing.
	return candidates[0];
}

function extractMonoMode(args: string[]): { mode: string; args: string[] } {
	const sanitized: string[] = [];
	let mode = MODE_CODING;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === MODE_FLAG) {
			const value = (args[i + 1] ?? "").trim().toLowerCase();
			if (value === MODE_GAME) mode = MODE_GAME;
			i++;
			continue;
		}
		if (arg.startsWith(`${MODE_FLAG}=`)) {
			const value = arg.slice(`${MODE_FLAG}=`.length).trim().toLowerCase();
			if (value === MODE_GAME) mode = MODE_GAME;
			continue;
		}
		sanitized.push(arg);
	}

	return { mode, args: sanitized };
}

function normalizeGameChannelArgs(args: string[]): string[] {
	const normalized: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === GAME_CHANNEL_FLAG) {
			const value = args[i + 1];
			if (value !== undefined) {
				normalized.push(arg, value);
				i++;
				continue;
			}
			normalized.push(arg);
			continue;
		}
		if (arg.startsWith(`${GAME_CHANNEL_FLAG}=`)) {
			const value = arg.slice(`${GAME_CHANNEL_FLAG}=`.length).trim();
			if (value) {
				normalized.push(GAME_CHANNEL_FLAG, value);
			} else {
				normalized.push(GAME_CHANNEL_FLAG);
			}
			continue;
		}
		normalized.push(arg);
	}

	return normalized;
}

function buildPiArgs(userArgs: string[]): string[] {
	const here = dirname(fileURLToPath(import.meta.url));
	const normalizedArgs = normalizeGameChannelArgs(userArgs);
	const modeResult = extractMonoMode(normalizedArgs);
	const extensionPath = resolveExtensionPath(here, modeResult.mode);
	const sanitizedUserArgs = sanitizeToolsArgs(modeResult.args);

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
