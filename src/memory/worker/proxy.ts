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
import type {
	WorkerInitData,
	WorkerRequest,
	WorkerOutboundMessage,
} from "./protocol.js";

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
	return join(projectRoot, "dist/src/memory/worker/thread.js");
}

export class WorkerMemoryProxy implements MemorySearchManager {
	private worker: Worker;
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private dirty = true;
	private ready: Promise<void>;

	private readyReject: ((reason: Error) => void) | null = null;

	constructor(params: {
		agentId: string;
		workspaceDir: string;
		settings: ResolvedMemorySearchConfig;
	}) {
		const initData: WorkerInitData = {
			agentId: params.agentId,
			workspaceDir: params.workspaceDir,
			settings: params.settings,
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