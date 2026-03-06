import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { getUserConfigDir, getUserConfigPath } from "../memory/config/paths.js";

export type MonoPilotConfigObject = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadMonoPilotConfigObject(): Promise<MonoPilotConfigObject> {
	const configPath = getUserConfigPath();
	if (!existsSync(configPath)) return {};

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

	return parsed;
}

export async function saveMonoPilotConfigObject(config: MonoPilotConfigObject): Promise<void> {
	const configDir = getUserConfigDir();
	await mkdir(configDir, { recursive: true });
	const configPath = getUserConfigPath();
	const payload = JSON.stringify(config, null, 2);
	await writeFile(configPath, `${payload}\n`, "utf-8");
}