import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);

let sqliteWarningPatched = false;

export function requireNodeSqlite(): typeof import("node:sqlite") {
	try {
		suppressSqliteExperimentalWarning();
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
	const db = new DatabaseSync(path, { allowExtension });
	configureSqliteConnection(db);
	return db;
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

function configureSqliteConnection(db: DatabaseSync): void {
	try {
		db.exec("PRAGMA journal_mode=WAL;");
	} catch {}
	try {
		db.exec("PRAGMA busy_timeout=5000;");
	} catch {}
}

function suppressSqliteExperimentalWarning(): void {
	if (sqliteWarningPatched) return;
	sqliteWarningPatched = true;
	const originalEmitWarning = process.emitWarning.bind(process);
	process.emitWarning = ((warning: unknown, ...args: unknown[]) => {
		if (isSqliteExperimentalWarning(warning, args)) return;
		return originalEmitWarning(warning as never, ...(args as never[]));
	}) as typeof process.emitWarning;
}

function isSqliteExperimentalWarning(warning: unknown, args: unknown[]): boolean {
	const message =
		typeof warning === "string"
			? warning
			: warning instanceof Error
				? warning.message
				: (warning as { message?: string } | null)?.message;
	const name =
		warning instanceof Error
			? warning.name
			: (warning as { name?: string } | null)?.name;
	const type =
		typeof args[0] === "string"
			? args[0]
			: (args[0] as { type?: string } | null)?.type;
	const warningType = name ?? type;
	if (warningType !== "ExperimentalWarning") return false;
	if (!message) return false;
	return message.includes("SQLite is an experimental feature");
}