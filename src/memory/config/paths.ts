import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const MONO_PILOT_CONFIG_FILENAME = "config.json";

export function getUserConfigDir(): string {
	return join(homedir(), ".mono-pilot");
}

export function getUserConfigPath(): string {
	return resolve(getUserConfigDir(), MONO_PILOT_CONFIG_FILENAME);
}