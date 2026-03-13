export interface MonoPilotObservabilityFileConfig {
	enabled: boolean;
	flushIntervalMs: number;
}

export interface MonoPilotObservabilityConfig {
	enabled: boolean;
	file: MonoPilotObservabilityFileConfig;
}

const DEFAULT_FLUSH_INTERVAL_MS = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	const normalized = Math.floor(value);
	if (normalized < 0) {
		return fallback;
	}
	return normalized;
}

export function extractMonoPilotObservabilityConfig(
	config: Record<string, unknown> | undefined,
): MonoPilotObservabilityConfig {
	if (!config || !isRecord(config.observability)) {
		return {
			enabled: true,
			file: {
				enabled: true,
				flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
			},
		};
	}

	const observability = config.observability as Record<string, unknown>;
	const file = isRecord(observability.file) ? observability.file : undefined;

	return {
		enabled: observability.enabled !== false,
		file: {
			enabled: file?.enabled !== false,
			flushIntervalMs: normalizeNonNegativeInteger(file?.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS),
		},
	};
}
