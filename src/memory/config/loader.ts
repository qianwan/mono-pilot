import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { MemorySearchConfig, ResolvedMemorySearchConfig } from "./types.js";
import { resolveMemorySearchConfig } from "./resolve.js";
import { getUserConfigPath } from "./paths.js";

export interface MonoPilotConfigFile {
	memorySearch?: MemorySearchConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadMonoPilotConfig(): Promise<MonoPilotConfigFile | undefined> {
	const configPath = getUserConfigPath();
	if (!existsSync(configPath)) return undefined;

	const raw = await readFile(configPath, "utf-8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid JSON in mono-pilot config: ${message}`);
	}

	if (!isRecord(parsed)) {
		throw new Error("MonoPilot config root must be a JSON object.");
	}

	return parsed as MonoPilotConfigFile;
}

export async function loadResolvedMemorySearchConfig(): Promise<ResolvedMemorySearchConfig> {
	const config = await loadMonoPilotConfig();
	return resolveMemorySearchConfig(config?.memorySearch);
}