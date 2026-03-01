import { memorySearchDefaults } from "./defaults.js";
import type { MemorySearchConfig, ResolvedMemorySearchConfig } from "./types.js";

export function resolveMemorySearchConfig(
	overrides?: MemorySearchConfig,
): ResolvedMemorySearchConfig {
	if (!overrides) {
		return {
			...memorySearchDefaults,
			sources: [...memorySearchDefaults.sources],
			extraPaths: [...memorySearchDefaults.extraPaths],
			chunking: { ...memorySearchDefaults.chunking },
			query: {
				...memorySearchDefaults.query,
				hybrid: {
					...memorySearchDefaults.query.hybrid,
					mmr: { ...memorySearchDefaults.query.hybrid.mmr },
					temporalDecay: { ...memorySearchDefaults.query.hybrid.temporalDecay },
				},
			},
			flush: {
				...memorySearchDefaults.flush,
			},
			sync: {
				...memorySearchDefaults.sync,
			},
		};
	}

	const chunking = overrides.chunking;
	const query = overrides.query;
	const hybrid = query?.hybrid;
	const flush = overrides.flush;
	const sync = overrides.sync;
	const store = overrides.store;
	const vector = store?.vector;
	const cache = overrides.cache;

	return {
		enabled: overrides.enabled ?? memorySearchDefaults.enabled,
		provider: overrides.provider ?? memorySearchDefaults.provider,
		sources: overrides.sources ? [...overrides.sources] : [...memorySearchDefaults.sources],
		extraPaths: overrides.extraPaths ? [...overrides.extraPaths] : [...memorySearchDefaults.extraPaths],
		local: {
			modelPath: overrides.local?.modelPath ?? memorySearchDefaults.local.modelPath,
			modelCacheDir: overrides.local?.modelCacheDir ?? memorySearchDefaults.local.modelCacheDir,
		},
		store: {
			vector: {
				enabled: vector?.enabled ?? memorySearchDefaults.store.vector.enabled,
				extensionPath: vector?.extensionPath ?? memorySearchDefaults.store.vector.extensionPath,
			},
		},
		chunking: {
			tokens: chunking?.tokens ?? memorySearchDefaults.chunking.tokens,
			overlap: chunking?.overlap ?? memorySearchDefaults.chunking.overlap,
		},
		query: {
			maxResults: query?.maxResults ?? memorySearchDefaults.query.maxResults,
			minScore: query?.minScore ?? memorySearchDefaults.query.minScore,
			hybrid: {
				enabled: hybrid?.enabled ?? memorySearchDefaults.query.hybrid.enabled,
				vectorWeight: hybrid?.vectorWeight ?? memorySearchDefaults.query.hybrid.vectorWeight,
				textWeight: hybrid?.textWeight ?? memorySearchDefaults.query.hybrid.textWeight,
				candidateMultiplier:
					hybrid?.candidateMultiplier ?? memorySearchDefaults.query.hybrid.candidateMultiplier,
				mmr: {
					enabled: hybrid?.mmr?.enabled ?? memorySearchDefaults.query.hybrid.mmr.enabled,
					lambda: hybrid?.mmr?.lambda ?? memorySearchDefaults.query.hybrid.mmr.lambda,
				},
				temporalDecay: {
					enabled:
						hybrid?.temporalDecay?.enabled ??
						memorySearchDefaults.query.hybrid.temporalDecay.enabled,
					halfLifeDays:
						hybrid?.temporalDecay?.halfLifeDays ??
						memorySearchDefaults.query.hybrid.temporalDecay.halfLifeDays,
				},
			},
		},
		flush: {
			onSessionSwitch: flush?.onSessionSwitch ?? memorySearchDefaults.flush.onSessionSwitch,
			onSessionCompact: flush?.onSessionCompact ?? memorySearchDefaults.flush.onSessionCompact,
			deltaBytes: flush?.deltaBytes ?? memorySearchDefaults.flush.deltaBytes,
			deltaMessages: flush?.deltaMessages ?? memorySearchDefaults.flush.deltaMessages,
		},
		sync: {
			onSessionStart: sync?.onSessionStart ?? memorySearchDefaults.sync.onSessionStart,
			onSearch: sync?.onSearch ?? memorySearchDefaults.sync.onSearch,
			watch: sync?.watch ?? memorySearchDefaults.sync.watch,
			watchDebounceMs: sync?.watchDebounceMs ?? memorySearchDefaults.sync.watchDebounceMs,
			intervalMinutes: sync?.intervalMinutes ?? memorySearchDefaults.sync.intervalMinutes,
		},
		cache: {
			enabled: cache?.enabled ?? memorySearchDefaults.cache.enabled,
			maxEntries: cache?.maxEntries ?? memorySearchDefaults.cache.maxEntries,
		},
	};
}