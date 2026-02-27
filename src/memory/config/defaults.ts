import type { ResolvedMemorySearchConfig } from "./types.js";

export const memorySearchDefaults: ResolvedMemorySearchConfig = {
	enabled: true,
	scope: "agent",
	sources: ["memory"],
	extraPaths: [],
	chunking: {
		tokens: 400,
		overlap: 80,
	},
	query: {
		maxResults: 6,
		minScore: 0.35,
		hybrid: {
			enabled: true,
			vectorWeight: 0.7,
			textWeight: 0.3,
			candidateMultiplier: 4,
			mmr: {
				enabled: false,
				lambda: 0.7,
			},
			temporalDecay: {
				enabled: false,
				halfLifeDays: 30,
			},
		},
	},
	sync: {
		onSessionStart: true,
		onSearch: true,
		watch: true,
		watchDebounceMs: 1500,
		intervalMinutes: 0,
		sessions: {
			deltaBytes: 100_000,
			deltaMessages: 50,
		},
	},
};