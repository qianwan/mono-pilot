import type { ResolvedMemorySearchConfig } from "./types.js";
import { homedir } from "node:os";
import { join } from "node:path";

export const memorySearchDefaults: ResolvedMemorySearchConfig = {
	enabled: true,
	provider: "local",
	sources: ["memory"],
	extraPaths: [],
	local: {
		modelPath: "hf:gpustack/bge-m3-GGUF/bge-m3-Q8_0.gguf",
		modelCacheDir: join(homedir(), ".mono-pilot", "models"),
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