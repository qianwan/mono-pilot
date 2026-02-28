import type { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import chokidar, { type FSWatcher } from "chokidar";
import type { MemorySearchManager, MemorySearchQueryOptions, MemorySearchResult } from "../types.js";
import type { ResolvedMemorySearchConfig } from "../config/types.js";
import { getAgentMemoryDir, getAgentMemoryIndexPath } from "../agents-paths.js";
import { openSqliteDatabase } from "../store/sqlite.js";
import { ensureMemoryIndexSchema } from "../store/schema.js";
import { FILES_TABLE, CHUNKS_TABLE, FTS_TABLE, VECTOR_TABLE } from "../store/schema.js";
import { buildFileEntry, hashText, listMemoryFiles, resolveExtraPaths } from "../indexing/files.js";
import { indexMemoryFile } from "../indexing/index-file.js";
import { searchFts } from "../search/fts.js";
import { searchVector } from "../search/vector.js";
import { mergeHybridResults } from "../search/hybrid.js";
import { loadSqliteVecExtension } from "../store/sqlite.js";
import { createEmbeddingProvider } from "../embeddings/provider.js";
import type { EmbeddingProvider } from "../embeddings/types.js";

const SNIPPET_MAX_CHARS = 400;

export class MemoryIndexManager implements MemorySearchManager {
	private readonly agentId: string;
	private readonly workspaceDir: string;
	private readonly settings: ResolvedMemorySearchConfig;
	private readonly db: DatabaseSync;
	private readonly memoryDir: string;
	private readonly ftsAvailable: boolean;
	private provider: EmbeddingProvider | null = null;
	private providerPromise: Promise<EmbeddingProvider | null> | null = null;
	private providerKey: string | null = null;
	private vectorAvailable: boolean | null = null;
	private vectorDims?: number;
	private dirty = false;
	private watcher: FSWatcher | null = null;
	private watchTimer: NodeJS.Timeout | null = null;

	constructor(params: { agentId: string; workspaceDir: string; settings: ResolvedMemorySearchConfig }) {
		this.agentId = params.agentId;
		this.workspaceDir = params.workspaceDir;
		this.settings = params.settings;
		this.memoryDir = getAgentMemoryDir(params.agentId);
		this.db = openSqliteDatabase(getAgentMemoryIndexPath(params.agentId), true);
		const schema = ensureMemoryIndexSchema({ db: this.db, ftsEnabled: true });
		this.ftsAvailable = schema.ftsAvailable;
		if (schema.ftsError) {
			console.warn(`[memory] FTS unavailable: ${schema.ftsError}`);
		}
		this.dirty = true;
		this.ensureWatcher();
	}

	async search(query: string, opts?: MemorySearchQueryOptions): Promise<MemorySearchResult[]> {
		const cleaned = query.trim();
		if (!cleaned) return [];
		if (this.settings.sync.onSearch && this.dirty) {
			await this.sync({ reason: "search" }).catch((err) => {
				console.warn(`[memory] sync failed (search): ${String(err)}`);
			});
		}
		const maxResults = opts?.maxResults ?? this.settings.query.maxResults;
		const minScore = opts?.minScore ?? this.settings.query.minScore;

		const provider = await this.getProvider();
		if (provider) {
			try {
				const queryEmbedding = await provider.embedQuery(cleaned);
				const vectorReady = await this.ensureVectorReady(queryEmbedding.length);
				if (vectorReady) {
					const hybrid = this.settings.query.hybrid;
					const candidateLimit = Math.min(
						200,
						Math.max(1, Math.floor(maxResults * hybrid.candidateMultiplier)),
					);
					const vectorResults = await searchVector({
						db: this.db,
						queryVec: queryEmbedding,
						limit: hybrid.enabled ? candidateLimit : maxResults,
						snippetMaxChars: SNIPPET_MAX_CHARS,
						model: provider.model,
					});
					if (!hybrid.enabled || !this.ftsAvailable) {
						return vectorResults
							.map((row) => ({
								path: row.path,
								startLine: row.startLine,
								endLine: row.endLine,
								score: row.vectorScore,
								snippet: row.snippet,
								source: "memory" as const,
							}))
							.filter((row) => row.score >= minScore)
							.slice(0, maxResults);
					}
					const keywordResults = searchFts({
						db: this.db,
						query: cleaned,
						limit: candidateLimit,
						minScore: 0,
						snippetMaxChars: SNIPPET_MAX_CHARS,
						model: provider.model,
					});
					const merged = mergeHybridResults({
						vector: vectorResults,
						keyword: keywordResults,
						vectorWeight: hybrid.vectorWeight,
						textWeight: hybrid.textWeight,
					});
					return merged
						.filter((row) => row.score >= minScore)
						.sort((a, b) => b.score - a.score)
						.slice(0, maxResults)
						.map((row) => ({
							path: row.path,
							startLine: row.startLine,
							endLine: row.endLine,
							score: row.score,
							snippet: row.snippet,
							source: "memory" as const,
						}));
				}
			} catch (error) {
				console.warn(`[memory] vector search failed: ${String(error)}`);
			}
		}

		if (!this.ftsAvailable) return [];
		const rows = searchFts({
			db: this.db,
			query: cleaned,
			limit: maxResults,
			minScore,
			snippetMaxChars: SNIPPET_MAX_CHARS,
			model: provider?.model,
		});
		return rows.map((row) => ({
			path: row.path,
			startLine: row.startLine,
			endLine: row.endLine,
			score: row.score,
			snippet: row.snippet,
			source: "memory" as const,
		}));
	}

	async get(path: string, from?: number, lines?: number): Promise<{ path: string; text: string }> {
		const raw = await readFile(path, "utf-8");
		if (from === undefined && lines === undefined) {
			return { path, text: raw };
		}
		const startLine = Math.max(1, Math.floor(from ?? 1));
		const maxLines = lines !== undefined ? Math.max(0, Math.floor(lines)) : undefined;
		const allLines = raw.split("\n");
		const startIndex = Math.min(allLines.length, Math.max(0, startLine - 1));
		const endIndex =
			maxLines === undefined ? allLines.length : Math.min(allLines.length, startIndex + maxLines);
		return { path, text: allLines.slice(startIndex, endIndex).join("\n") };
	}

	isDirty(): boolean {
		return this.dirty;
	}

	async sync(params?: { reason?: string; force?: boolean }): Promise<void> {
		const provider = await this.getProvider();
		if (provider && !this.providerKey) {
			this.providerKey = hashText(provider.model);
		}
		const embeddingsContext = provider
			? {
				provider,
				providerKey: this.providerKey ?? hashText(provider.model),
				cache: this.settings.cache,
				vector: {
					enabled: this.settings.store.vector.enabled,
					ensureReady: this.ensureVectorReady.bind(this),
				},
			}
			: undefined;
		const files = await listMemoryFiles({
			memoryDir: this.memoryDir,
			extraPaths: this.settings.extraPaths,
			workspaceDir: this.workspaceDir,
		});
		const entries = (await Promise.all(files.map((file) => buildFileEntry(file)))).filter(
			(entry): entry is NonNullable<typeof entry> => entry !== null,
		);
		const activePaths = new Set(entries.map((entry) => entry.path));
		for (const entry of entries) {
			const record = this.db
				.prepare(`SELECT hash FROM ${FILES_TABLE} WHERE path = ? AND source = ?`)
				.get(entry.path, "memory") as { hash: string } | undefined;
			if (!params?.force && record?.hash === entry.hash) {
				continue;
			}
			await indexMemoryFile({
				db: this.db,
				entry,
				source: "memory",
				chunking: this.settings.chunking,
				ftsAvailable: this.ftsAvailable,
				embeddings: embeddingsContext,
			});
			this.db
				.prepare(
					`INSERT INTO ${FILES_TABLE} (path, source, hash, mtime, size)
					 VALUES (?, ?, ?, ?, ?)
					 ON CONFLICT(path) DO UPDATE SET
					   hash=excluded.hash,
					   mtime=excluded.mtime,
					   size=excluded.size`,
				)
				.run(entry.path, "memory", entry.hash, Math.round(entry.mtimeMs), entry.size);
		}

		const staleRows = this.db
			.prepare(`SELECT path FROM ${FILES_TABLE} WHERE source = ?`)
			.all("memory") as Array<{ path: string }>;
		for (const stale of staleRows) {
			if (activePaths.has(stale.path)) continue;
			this.db.prepare(`DELETE FROM ${FILES_TABLE} WHERE path = ? AND source = ?`).run(stale.path, "memory");
			if (this.settings.store.vector.enabled) {
				try {
					this.db
						.prepare(
							`DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM ${CHUNKS_TABLE} WHERE path = ? AND source = ?)`,
						)
						.run(stale.path, "memory");
				} catch {}
			}
			this.db.prepare(`DELETE FROM ${CHUNKS_TABLE} WHERE path = ? AND source = ?`).run(stale.path, "memory");
			if (this.ftsAvailable) {
				try {
					this.db
						.prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ?`)
						.run(stale.path, "memory");
				} catch {}
			}
		}

		this.dirty = false;
	}

	async close(): Promise<void> {
		if (this.watchTimer) {
			clearTimeout(this.watchTimer);
			this.watchTimer = null;
		}
		if (this.watcher) {
			void this.watcher.close();
			this.watcher = null;
		}
		if (this.provider?.dispose) {
			try {
				await this.provider.dispose();
			} catch (error) {
				console.warn(`[memory] embedding provider dispose failed: ${String(error)}`);
			}
		}
		this.provider = null;
		this.providerPromise = null;
		this.db.close();
	}

	private async getProvider(): Promise<EmbeddingProvider | null> {
		if (this.provider) return this.provider;
		if (this.providerPromise) return await this.providerPromise;
		this.providerPromise = (async () => {
			try {
				const provider = await createEmbeddingProvider(this.settings);
				this.provider = provider;
				if (provider) {
					this.providerKey = hashText(provider.model);
				}
				return provider;
			} catch (error) {
				console.warn(`[memory] embedding provider unavailable: ${String(error)}`);
				return null;
			}
		})();
		return await this.providerPromise;
	}

	private async ensureVectorReady(dimensions: number): Promise<boolean> {
		if (!this.settings.store.vector.enabled) return false;
		if (!dimensions || dimensions <= 0) return false;
		if (this.vectorAvailable === false) return false;
		if (this.vectorAvailable === null) {
			const loaded = await loadSqliteVecExtension({
				db: this.db,
				extensionPath: this.settings.store.vector.extensionPath,
			});
			if (!loaded.ok) {
				this.vectorAvailable = false;
				console.warn(`[memory] sqlite-vec unavailable: ${loaded.error ?? "unknown"}`);
				return false;
			}
			this.vectorAvailable = true;
		}
		this.ensureVectorTable(dimensions);
		return true;
	}

	private ensureVectorTable(dimensions: number): void {
		if (this.vectorDims === dimensions) return;
		if (this.vectorDims && this.vectorDims !== dimensions) {
			try {
				this.db.exec(`DROP TABLE IF EXISTS ${VECTOR_TABLE}`);
			} catch {}
		}
		this.db.exec(
			`CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(\n` +
				`  id TEXT PRIMARY KEY,\n` +
				`  embedding FLOAT[${dimensions}]\n` +
				`)`,
		);
		this.vectorDims = dimensions;
	}

	private ensureWatcher(): void {
		if (!this.settings.sync.watch || this.watcher) return;
		const watchPaths = new Set<string>();
		watchPaths.add(this.memoryDir);
		for (const extra of resolveExtraPaths(this.workspaceDir, this.settings.extraPaths)) {
			watchPaths.add(extra);
		}
		this.watcher = chokidar.watch(Array.from(watchPaths), {
			ignoreInitial: true,
			awaitWriteFinish: {
				stabilityThreshold: this.settings.sync.watchDebounceMs,
				pollInterval: 100,
			},
		});
		const markDirty = () => {
			this.dirty = true;
			this.scheduleWatchSync();
		};
		this.watcher.on("add", markDirty);
		this.watcher.on("change", markDirty);
		this.watcher.on("unlink", markDirty);
	}

	private scheduleWatchSync(): void {
		if (!this.settings.sync.watch) return;
		if (this.watchTimer) {
			clearTimeout(this.watchTimer);
		}
		this.watchTimer = setTimeout(() => {
			this.watchTimer = null;
			void this.sync({ reason: "watch" }).catch((err) => {
				console.warn(`[memory] sync failed (watch): ${String(err)}`);
			});
		}, this.settings.sync.watchDebounceMs);
	}
}