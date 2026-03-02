import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import type {
	MemorySearchManager,
	MemorySearchResult,
	MemorySearchGetResult,
	MemorySearchQueryOptions,
	MemorySearchSyncOptions,
} from "../types.js";
import type { ResolvedMemorySearchConfig } from "../config/types.js";
import { loadResolvedMemorySearchConfig } from "../config/loader.js";

// --- Protocol types (shared with thread.ts) ---

export interface WorkerInitData {
	agentId: string;
	workspaceDir: string;
	settings: ResolvedMemorySearchConfig;
	embedModel?: string;
}

export type WorkerRequest =
	| { id: number; type: "search"; query: string; opts?: MemorySearchQueryOptions }
	| { id: number; type: "sync"; opts?: MemorySearchSyncOptions }
	| { id: number; type: "syncDirty" }
	| { id: number; type: "close" };

export interface WorkerResultResponse {
	id: number;
	type: "result";
	data: unknown;
}

export interface WorkerErrorResponse {
	id: number;
	type: "error";
	message: string;
}

export type WorkerResponse = WorkerResultResponse | WorkerErrorResponse;

export type WorkerNotification =
	| { type: "ready" }
	| { type: "dirty"; value: boolean };

export type WorkerOutboundMessage = WorkerResponse | WorkerNotification;

import type { EmbeddingProvider } from "../embeddings/types.js";

// --- Worker proxy (main thread) ---

interface Pending {
	resolve: (value: any) => void;
	reject: (reason: Error) => void;
}

// When running via tsx (dev), import.meta.url points to src/ but worker threads
// need compiled JS. Detect this and redirect to dist/.
function resolveWorkerPath(): string {
	const thisFile = fileURLToPath(import.meta.url);
	const thisDir = dirname(thisFile);
	const threadFile = join(thisDir, "thread.js");
	if (thisDir.includes(`${join("dist", "src")}`)) {
		return threadFile;
	}
	const projectRoot = resolve(thisDir, "../../..");
	return join(projectRoot, "dist/src/memory/runtime/thread.js");
}

class WorkerMemoryProxy implements MemorySearchManager {
	private worker: Worker;
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private dirty = true;
	private ready: Promise<void>;

	private readyReject: ((reason: Error) => void) | null = null;
	private embeddingProvider: EmbeddingProvider | null = null;

	constructor(params: {
		agentId: string;
		workspaceDir: string;
		settings: ResolvedMemorySearchConfig;
		embedModel?: string;
	}) {
		const initData: WorkerInitData = {
			agentId: params.agentId,
			workspaceDir: params.workspaceDir,
			settings: params.settings,
			embedModel: params.embedModel,
		};

		this.worker = new Worker(resolveWorkerPath(), {
			workerData: initData,
			execArgv: ["--no-warnings"],
		});
		// Don't let the worker prevent process exit as a last resort.
		this.worker.unref();

		this.ready = new Promise<void>((resolve, reject) => {
			this.readyReject = reject;
			const onMessage = (msg: WorkerOutboundMessage) => {
				if (msg.type === "ready") {
					this.worker.removeListener("message", onMessage);
					this.readyReject = null;
					resolve();
				}
			};
			this.worker.on("message", onMessage);
		});

		this.worker.on("message", (msg: WorkerOutboundMessage) => {
			if (msg.type === "dirty") {
				this.dirty = msg.value;
				return;
			}
			if (msg.type === "ready") return;
			// Embed request from worker — forward to main-thread provider
			if ((msg as any).type === "embed") {
				void this.handleEmbedRequest(msg as any);
				return;
			}
			// WorkerResponse
			const pending = this.pending.get(msg.id);
			if (!pending) return;
			this.pending.delete(msg.id);
			if (msg.type === "error") {
				pending.reject(new Error(msg.message));
			} else {
				pending.resolve(msg.data);
			}
		});

		this.worker.on("error", (err) => {
			this.rejectReady(err);
			this.rejectAll(err);
		});

		this.worker.on("exit", (code) => {
			const err = new Error(`Memory worker exited with code ${code}`);
			this.rejectReady(err);
			if (code !== 0) {
				this.rejectAll(err);
			}
		});
	}

	async search(query: string, opts?: MemorySearchQueryOptions): Promise<MemorySearchResult[]> {
		await this.ready;
		return this.send({ type: "search", query, opts }) as Promise<MemorySearchResult[]>;
	}

	// File read only — no DB, runs on main thread.
	async get(path: string, from?: number, lines?: number): Promise<MemorySearchGetResult> {
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

	async sync(opts?: MemorySearchSyncOptions): Promise<void> {
		await this.ready;
		await this.send({ type: "sync", opts });
	}

	async syncDirty(): Promise<string[]> {
		await this.ready;
		return this.send({ type: "syncDirty" }) as Promise<string[]>;
	}

	isDirty(): boolean {
		return this.dirty;
	}

	/** Set the embedding provider used to serve worker embed requests. */
	setEmbeddingProvider(provider: EmbeddingProvider): void {
		this.embeddingProvider = provider;
	}

	private async handleEmbedRequest(req: { id: number; texts: string[] }): Promise<void> {
		try {
			if (!this.embeddingProvider) {
				throw new Error("No embedding provider available");
			}
			const data = await this.embeddingProvider.embedBatch(req.texts);
			this.worker.postMessage({ type: "embedResult", id: req.id, data });
		} catch (err) {
			this.worker.postMessage({
				type: "embedResult",
				id: req.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	async close(): Promise<void> {
		const CLOSE_TIMEOUT_MS = 3000;
		try {
			await Promise.race([
				this.send({ type: "close" }),
				new Promise<void>((_, reject) => {
					const timer = setTimeout(() => reject(new Error("close timeout")), CLOSE_TIMEOUT_MS);
					timer.unref();
				}),
			]);
		} catch {
			// Worker may already be gone.
		}
		// Force-terminate without waiting — don't block process exit.
		this.worker.terminate().catch(() => {});
		this.pending.clear();
	}

	private send(partial: { type: string; [key: string]: unknown }): Promise<unknown> {
		const id = this.nextId++;
		const req = { ...partial, id };
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.worker.postMessage(req);
		});
	}

	private rejectReady(err: Error): void {
		if (this.readyReject) {
			this.readyReject(err);
			this.readyReject = null;
		}
	}

	private rejectAll(err: Error): void {
		for (const pending of this.pending.values()) {
			pending.reject(err);
		}
		this.pending.clear();
	}
}

// --- Singleton registry ---

const managerCache = new Map<string, WorkerMemoryProxy>();
let defaultEmbeddingProvider: EmbeddingProvider | null = null;

export async function getMemorySearchManager(params: {
	workspaceDir: string;
	agentId: string;
}): Promise<WorkerMemoryProxy | null> {
	const settings = await loadResolvedMemorySearchConfig();
	if (!settings.enabled) return null;
	if (!settings.sources.includes("memory") && !settings.sources.includes("sessions")) return null;

	const key = params.agentId;
	const cached = managerCache.get(key);
	if (cached) return cached;

	const manager = new WorkerMemoryProxy({
		agentId: params.agentId,
		workspaceDir: params.workspaceDir,
		settings,
		embedModel: defaultEmbeddingProvider?.model,
	});
	if (defaultEmbeddingProvider) {
		manager.setEmbeddingProvider(defaultEmbeddingProvider);
	}
	managerCache.set(key, manager);
	return manager;
}

export async function closeMemorySearchManagers(): Promise<void> {
	const managers = Array.from(managerCache.values());
	managerCache.clear();
	for (const manager of managers) {
		if (manager.close) {
			await manager.close();
		}
	}
}

export function peekMemorySearchManager(params: {
	agentId: string;
}): WorkerMemoryProxy | null {
	const key = params.agentId;
	return managerCache.get(key) ?? null;
}

/** Set the embedding provider on all active worker proxies. */
export function setMemoryWorkersEmbeddingProvider(provider: EmbeddingProvider): void {
	defaultEmbeddingProvider = provider;
	for (const proxy of managerCache.values()) {
		proxy.setEmbeddingProvider(provider);
	}
}

/** Get the current default embedding provider (if any). */
export function getDefaultEmbeddingProvider(): EmbeddingProvider | null {
	return defaultEmbeddingProvider;
}