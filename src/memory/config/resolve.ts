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
			sync: {
				...memorySearchDefaults.sync,
				sessions: { ...memorySearchDefaults.sync.sessions },
			},
		};
	}

	const chunking = overrides.chunking;
	const query = overrides.query;
	const hybrid = query?.hybrid;
	const sync = overrides.sync;
	const sessions = sync?.sessions;
	const store = overrides.store;
	const vector = store?.vector;
	const cache = overrides.cache;

	return {
		enabled: overrides.enabled ?? memorySearchDefaults.enabled,
		provider: overrides.provider ?? memorySearchDefaults.provider,
		scope: overrides.scope ?? memorySearchDefaults.scope,
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
		sync: {
			onSessionStart: sync?.onSessionStart ?? memorySearchDefaults.sync.onSessionStart,
			onSearch: sync?.onSearch ?? memorySearchDefaults.sync.onSearch,
			watch: sync?.watch ?? memorySearchDefaults.sync.watch,
			watchDebounceMs: sync?.watchDebounceMs ?? memorySearchDefaults.sync.watchDebounceMs,
			intervalMinutes: sync?.intervalMinutes ?? memorySearchDefaults.sync.intervalMinutes,
			sessions: {
				deltaBytes: sessions?.deltaBytes ?? memorySearchDefaults.sync.sessions.deltaBytes,
				deltaMessages: sessions?.deltaMessages ?? memorySearchDefaults.sync.sessions.deltaMessages,
			},
		},
		cache: {
			enabled: cache?.enabled ?? memorySearchDefaults.cache.enabled,
			maxEntries: cache?.maxEntries ?? memorySearchDefaults.cache.maxEntries,
		},
	};
}