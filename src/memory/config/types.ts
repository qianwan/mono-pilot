import type { MemoryScope, MemorySource } from "../types.js";

export interface MemorySearchChunkingConfig {
	tokens?: number;
	overlap?: number;
}

export interface MemorySearchHybridConfig {
	enabled?: boolean;
	vectorWeight?: number;
	textWeight?: number;
	candidateMultiplier?: number;
	mmr?: {
		enabled?: boolean;
		lambda?: number;
	};
	temporalDecay?: {
		enabled?: boolean;
		halfLifeDays?: number;
	};
}

export interface MemorySearchQueryConfig {
	maxResults?: number;
	minScore?: number;
	hybrid?: MemorySearchHybridConfig;
}

export interface MemorySearchSyncSessionsConfig {
	deltaBytes?: number;
	deltaMessages?: number;
}

export interface MemorySearchSyncConfig {
	onSessionStart?: boolean;
	onSearch?: boolean;
	watch?: boolean;
	watchDebounceMs?: number;
	intervalMinutes?: number;
	sessions?: MemorySearchSyncSessionsConfig;
}

export interface MemorySearchConfig {
	enabled?: boolean;
	scope?: MemoryScope;
	sources?: MemorySource[];
	extraPaths?: string[];
	chunking?: MemorySearchChunkingConfig;
	query?: MemorySearchQueryConfig;
	sync?: MemorySearchSyncConfig;
}

export interface ResolvedMemorySearchConfig {
	enabled: boolean;
	scope: MemoryScope;
	sources: MemorySource[];
	extraPaths: string[];
	chunking: {
		tokens: number;
		overlap: number;
	};
	query: {
		maxResults: number;
		minScore: number;
		hybrid: {
			enabled: boolean;
			vectorWeight: number;
			textWeight: number;
			candidateMultiplier: number;
			mmr: {
				enabled: boolean;
				lambda: number;
			};
			temporalDecay: {
				enabled: boolean;
				halfLifeDays: number;
			};
		};
	};
	sync: {
		onSessionStart: boolean;
		onSearch: boolean;
		watch: boolean;
		watchDebounceMs: number;
		intervalMinutes: number;
		sessions: {
			deltaBytes: number;
			deltaMessages: number;
		};
	};
}