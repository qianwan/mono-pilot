import type { DatabaseSync } from "node:sqlite";

export const FILES_TABLE = "files";
export const CHUNKS_TABLE = "chunks";
export const FTS_TABLE = "chunks_fts";
export const EMBEDDING_CACHE_TABLE = "embedding_cache";
export const VECTOR_TABLE = "chunks_vec";

export function ensureMemoryIndexSchema(params: {
	db: DatabaseSync;
	ftsEnabled: boolean;
}): { ftsAvailable: boolean; ftsError?: string } {
	params.db.exec(`
		CREATE TABLE IF NOT EXISTS meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
	`);
	params.db.exec(`
		CREATE TABLE IF NOT EXISTS ${FILES_TABLE} (
			path TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			source TEXT NOT NULL DEFAULT 'memory',
			hash TEXT NOT NULL,
			mtime INTEGER NOT NULL,
			size INTEGER NOT NULL,
			PRIMARY KEY (path, agent_id)
		);
	`);
	params.db.exec(`
		CREATE TABLE IF NOT EXISTS ${CHUNKS_TABLE} (
			id TEXT PRIMARY KEY,
			path TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			source TEXT NOT NULL DEFAULT 'memory',
			start_line INTEGER NOT NULL,
			end_line INTEGER NOT NULL,
			hash TEXT NOT NULL,
			model TEXT NOT NULL,
			text TEXT NOT NULL,
			embedding TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		);
	`);
	params.db.exec(`
		CREATE TABLE IF NOT EXISTS ${EMBEDDING_CACHE_TABLE} (
			provider TEXT NOT NULL,
			model TEXT NOT NULL,
			provider_key TEXT NOT NULL,
			hash TEXT NOT NULL,
			embedding TEXT NOT NULL,
			dims INTEGER,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (provider, model, provider_key, hash)
		);
	`);
	params.db.exec(
		`CREATE INDEX IF NOT EXISTS idx_embedding_cache_updated_at ON ${EMBEDDING_CACHE_TABLE}(updated_at);`,
	);

	let ftsAvailable = false;
	let ftsError: string | undefined;
	if (params.ftsEnabled) {
		try {
			params.db.exec(
				`CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
					text,
					id UNINDEXED,
					path UNINDEXED,
					source UNINDEXED,
					model UNINDEXED,
					start_line UNINDEXED,
					end_line UNINDEXED
				);`,
			);
			ftsAvailable = true;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			ftsAvailable = false;
			ftsError = message;
		}
	}

	ensureColumn(params.db, FILES_TABLE, "source", "TEXT NOT NULL DEFAULT 'memory'");
	ensureColumn(params.db, FILES_TABLE, "agent_id", "TEXT NOT NULL DEFAULT ''");
	ensureColumn(params.db, CHUNKS_TABLE, "source", "TEXT NOT NULL DEFAULT 'memory'");
	ensureColumn(params.db, CHUNKS_TABLE, "agent_id", "TEXT NOT NULL DEFAULT ''");
	params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_path ON ${CHUNKS_TABLE}(path);`);
	params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_source ON ${CHUNKS_TABLE}(source);`);
	params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_agent_id ON ${CHUNKS_TABLE}(agent_id);`);
	params.db.exec(`CREATE INDEX IF NOT EXISTS idx_files_agent_id ON ${FILES_TABLE}(agent_id);`);

	return { ftsAvailable, ...(ftsError ? { ftsError } : {}) };
}

function ensureColumn(
	db: DatabaseSync,
	table: string,
	column: string,
	definition: string,
): void {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	if (rows.some((row) => row.name === column)) {
		return;
	}
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

