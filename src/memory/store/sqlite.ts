import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { ensureDir } from "./fs.js";

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