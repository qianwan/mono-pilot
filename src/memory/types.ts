export type MemorySource = "memory";

export type MemoryScope = "agent" | "all";

export interface MemorySearchResult {
	path: string;
	startLine: number;
	endLine: number;
	score: number;
	snippet: string;
	source: MemorySource;
	agentId?: string;
	citation?: string;
}

export interface MemorySearchQueryOptions {
	maxResults?: number;
	minScore?: number;
	sessionKey?: string;
}

export interface MemorySearchGetResult {
	path: string;
	text: string;
}

export interface MemorySearchSyncOptions {
	reason?: string;
	force?: boolean;
}

export interface MemorySearchManager {
	search(query: string, opts?: MemorySearchQueryOptions): Promise<MemorySearchResult[]>;
	get(path: string, from?: number, lines?: number): Promise<MemorySearchGetResult>;
	sync?(opts?: MemorySearchSyncOptions): Promise<void>;
	isDirty?(): boolean;
	syncDirty?(): Promise<string[]>;
	close?(): Promise<void>;
}