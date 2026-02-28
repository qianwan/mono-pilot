import type { MemorySearchQueryOptions, MemorySearchSyncOptions } from "../types.js";
import type { ResolvedMemorySearchConfig } from "../config/types.js";

// Data passed to the worker via workerData.
export interface WorkerInitData {
	agentId: string;
	workspaceDir: string;
	settings: ResolvedMemorySearchConfig;
}

// Main thread -> Worker requests.
export type WorkerRequest =
	| { id: number; type: "search"; query: string; opts?: MemorySearchQueryOptions }
	| { id: number; type: "sync"; opts?: MemorySearchSyncOptions }
	| { id: number; type: "syncDirty" }
	| { id: number; type: "close" };

// Worker -> Main thread responses (matched by id).
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

// Worker -> Main thread unsolicited notifications.
export type WorkerNotification =
	| { type: "ready" }
	| { type: "dirty"; value: boolean };

// All messages the worker can post.
export type WorkerOutboundMessage = WorkerResponse | WorkerNotification;