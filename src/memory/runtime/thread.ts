import { parentPort, workerData } from "node:worker_threads";
import type { WorkerInitData, WorkerRequest, WorkerOutboundMessage } from "./index.js";
import type { MemorySearchManager } from "../types.js";
import type { EmbedFn, MemoryAutoSyncEvent } from "../index-manager.js";
import { MemoryIndexManager } from "../index-manager.js";
import { memoryLog } from "../log.js";

function post(msg: WorkerOutboundMessage): void {
	parentPort?.postMessage(msg);
}

// Embed requests are forwarded to main thread via postMessage.
// Each request gets a unique id; main thread replies with the result.
let embedNextId = 1;
const embedPending = new Map<number, { resolve: (v: number[][]) => void; reject: (e: Error) => void }>();

const embedViaMainThread: EmbedFn = (texts) => {
	const id = embedNextId++;
	return new Promise((resolve, reject) => {
		embedPending.set(id, { resolve, reject });
		post({ type: "embed", id, texts } as any);
	});
};

let manager: MemorySearchManager | null = null;
let dirtyTimer: ReturnType<typeof setInterval> | null = null;

try {
	const init = workerData as WorkerInitData;
	let lastDirty = true;

	manager = new MemoryIndexManager({
		agentId: init.agentId,
		workspaceDir: init.workspaceDir,
		settings: init.settings,
		embedFn: embedViaMainThread,
		embedModel: init.embedModel,
		onAutoSyncEvent: (event: MemoryAutoSyncEvent) => {
			post({ type: "autoSyncEvent", event });
		},
	});
	memoryLog.info("worker initialized", { agentId: init.agentId });

	// Periodically broadcast dirty state so the proxy can cache it.
	const DIRTY_POLL_MS = 2000;
	dirtyTimer = setInterval(() => {
		const dirty = manager?.isDirty?.() ?? false;
		if (dirty !== lastDirty) {
			lastDirty = dirty;
			post({ type: "dirty", value: dirty });
		}
	}, DIRTY_POLL_MS);
	dirtyTimer.unref();

	parentPort?.on("message", (msg: WorkerRequest) => {
		// Embed response from main thread
		if ((msg as any).type === "embedResult") {
			const { id, data, error } = msg as any;
			const pending = embedPending.get(id);
			if (pending) {
				embedPending.delete(id);
				if (error) pending.reject(new Error(error));
				else pending.resolve(data);
			}
			return;
		}
		void handleRequest(msg);
	});

	post({ type: "ready" });
} catch (err) {
	// Initialization failed — let the process crash so the proxy's exit handler fires.
	const message = err instanceof Error ? err.message : String(err);
	console.error(`[memory-worker] init failed: ${message}`);
	memoryLog.error("worker init failed", { error: message });
	process.exit(1);
}

async function handleRequest(req: WorkerRequest): Promise<void> {
	if (!manager) {
		post({ id: req.id, type: "error", message: "Manager not initialized" });
		return;
	}
	try {
		let result: unknown;
		switch (req.type) {
			case "search":
				result = await manager.search(req.query, req.opts);
				break;
			case "sync":
				await manager.sync?.({
					...req.opts,
					onWorkDetected: req.notifyWorkDetected
						? () => {
							post({ type: "syncWorkDetected", requestId: req.id });
						}
						: undefined,
				});
				result = undefined;
				break;
			case "syncDirty":
				if (manager.syncDirty) {
					result = await manager.syncDirty();
				} else {
					await manager.sync?.({ reason: "build-dirty" });
					result = [];
				}
				break;
			case "close":
				if (dirtyTimer) clearInterval(dirtyTimer);
				await manager.close?.();
				result = undefined;
				break;
		}
		post({ id: req.id, type: "result", data: result });
	} catch (err) {
		post({
			id: req.id,
			type: "error",
			message: err instanceof Error ? err.message : String(err),
		});
	}
}