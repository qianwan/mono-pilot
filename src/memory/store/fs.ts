import { mkdirSync } from "node:fs";

export function ensureDir(path: string): void {
	try {
		mkdirSync(path, { recursive: true });
	} catch {
		// Ignore directory creation errors; caller handles downstream failures.
	}
}