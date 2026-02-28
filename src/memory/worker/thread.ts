import { parentPort, workerData } from "node:worker_threads";
import type { WorkerInitData, WorkerRequest, WorkerOutboundMessage } from "./protocol.js";
import type { MemorySearchManager } from "../types.js";
import { MemoryIndexManager } from "../manager/index-manager.js";
import { MultiAgentMemorySearchManager } from "../manager/multi-agent-manager.js";

function post(msg: WorkerOutboundMessage): void {
	parentPort?.postMessage(msg);
}

let manager: MemorySearchManager | null = null;
let dirtyTimer: ReturnType<typeof setInterval> | null = null;

try {
	const init = workerData as WorkerInitData;
	let lastDirty = true;

	if (init.settings.scope === "all") {
		manager = new MultiAgentMemorySearchManager({
			workspaceDir: init.workspaceDir,
			settings: init.settings,
		});
	} else {
		manager = new MemoryIndexManager({
			agentId: init.agentId,
			workspaceDir: init.workspaceDir,
			settings: init.settings,
		});
	}

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
		void handleRequest(msg);
	});

	post({ type: "ready" });
} catch (err) {
	// Initialization failed — let the process crash so the proxy's exit handler fires.
	const message = err instanceof Error ? err.message : String(err);
	console.error(`[memory-worker] init failed: ${message}`);
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
				await manager.sync?.(req.opts);
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