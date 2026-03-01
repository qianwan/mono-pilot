import type { MemorySource } from "../types.js";

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

export interface MemorySearchFlushConfig {
	onSessionSwitch?: boolean;
	onSessionCompact?: boolean;
	deltaBytes?: number;
	deltaMessages?: number;
}

export interface MemorySearchSyncConfig {
	onSessionStart?: boolean;
	onSearch?: boolean;
	watch?: boolean;
	watchDebounceMs?: number;
	intervalMinutes?: number;
}

export interface MemorySearchLocalConfig {
	modelPath?: string;
	modelCacheDir?: string;
}

export interface MemorySearchVectorConfig {
	enabled?: boolean;
	extensionPath?: string;
}

export interface MemorySearchStoreConfig {
	vector?: MemorySearchVectorConfig;
}

export interface MemorySearchCacheConfig {
	enabled?: boolean;
	maxEntries?: number;
}

export interface MemorySearchConfig {
	enabled?: boolean;
	provider?: "local";
	sources?: MemorySource[];
	extraPaths?: string[];
	local?: MemorySearchLocalConfig;
	store?: MemorySearchStoreConfig;
	chunking?: MemorySearchChunkingConfig;
	query?: MemorySearchQueryConfig;
	flush?: MemorySearchFlushConfig;
	sync?: MemorySearchSyncConfig;
	cache?: MemorySearchCacheConfig;
}

export interface ResolvedMemorySearchConfig {
	enabled: boolean;
	provider: "local";
	sources: MemorySource[];
	extraPaths: string[];
	local: {
		modelPath: string;
		modelCacheDir?: string;
	};
	store: {
		vector: {
			enabled: boolean;
			extensionPath?: string;
		};
	};
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
	flush: {
		onSessionSwitch: boolean;
		onSessionCompact: boolean;
		deltaBytes: number;
		deltaMessages: number;
	};
	sync: {
		onSessionStart: boolean;
		onSearch: boolean;
		watch: boolean;
		watchDebounceMs: number;
		intervalMinutes: number;
	};
	cache: {
		enabled: boolean;
		maxEntries?: number;
	};
}