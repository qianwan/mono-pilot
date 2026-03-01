import type { ResolvedMemorySearchConfig } from "./types.js";
import { DEFAULT_LOCAL_MODEL, DEFAULT_MODEL_CACHE_DIR } from "../embeddings/constants.js";

export const memorySearchDefaults: ResolvedMemorySearchConfig = {
	enabled: true,
	provider: "local",
	sources: ["memory"],
	extraPaths: [],
	local: {
		modelPath: DEFAULT_LOCAL_MODEL,
		modelCacheDir: DEFAULT_MODEL_CACHE_DIR,
	},
	store: {
		vector: {
			enabled: true,
		},
	},
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
	flush: {
		onSessionSwitch: true,
		onSessionCompact: true,
		deltaBytes: 100_000,
		deltaMessages: 50,
	},
	sync: {
		onSessionStart: true,
		onSearch: true,
		watch: true,
		watchDebounceMs: 1500,
		intervalMinutes: 10,
	},
	cache: {
		enabled: true,
	},
};