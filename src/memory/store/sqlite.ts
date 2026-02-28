import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);

export function requireNodeSqlite(): typeof import("node:sqlite") {
	try {
		return require("node:sqlite") as typeof import("node:sqlite");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(
			`SQLite support is unavailable in this Node runtime (missing node:sqlite). ${message}`,
			{ cause: err },
		);
	}
}

export function openSqliteDatabase(path: string, allowExtension = false): DatabaseSync {
	ensureDir(dirname(path));
	const { DatabaseSync } = requireNodeSqlite();
	return new DatabaseSync(path, { allowExtension });
}

export async function loadSqliteVecExtension(params: {
	db: DatabaseSync;
	extensionPath?: string;
}): Promise<{ ok: boolean; extensionPath?: string; error?: string }> {
	try {
		const sqliteVec = await import("sqlite-vec");
		const resolvedPath = params.extensionPath?.trim() ? params.extensionPath.trim() : undefined;
		const extensionPath = resolvedPath ?? sqliteVec.getLoadablePath();

		params.db.enableLoadExtension(true);
		if (resolvedPath) {
			params.db.loadExtension(extensionPath);
		} else {
			sqliteVec.load(params.db);
		}

		return { ok: true, extensionPath };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, error: message };
	}
}

function ensureDir(path: string): void {
	try {
		mkdirSync(path, { recursive: true });
	} catch {
		// Ignore directory creation errors; caller handles downstream failures.
	}
}