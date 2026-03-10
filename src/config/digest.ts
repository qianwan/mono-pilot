export interface DigestClassifierConfig {
	provider?: string;
	model?: string;
	temperature: number;
	maxTokens: number;
	concurrency: number;
}

export interface DigestConfig {
	classifier: DigestClassifierConfig;
}

const DEFAULT_TEMPERATURE = 0;
const DEFAULT_MAX_TOKENS = 300;
const DEFAULT_CONCURRENCY = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeNumber(
	value: unknown,
	fallback: number,
	{
		integer,
		min,
		max,
	}: { integer?: boolean; min?: number; max?: number } = {},
): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	let next = integer ? Math.floor(value) : value;
	if (typeof min === "number") {
		next = Math.max(min, next);
	}
	if (typeof max === "number") {
		next = Math.min(max, next);
	}
	return next;
}

function readClassifierRecord(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) {
		return {};
	}
	return isRecord(value.classifier) ? (value.classifier as Record<string, unknown>) : {};
}

function readTwitterDigestClassifier(config: Record<string, unknown>): Record<string, unknown> {
	if (!isRecord(config.twitter)) {
		return {};
	}
	const twitter = config.twitter as Record<string, unknown>;
	return readClassifierRecord(twitter.digest);
}

function readLegacyDigestClassifier(config: Record<string, unknown>): Record<string, unknown> {
	return readClassifierRecord(config.digest);
}

export function extractDigestConfig(config: Record<string, unknown> | undefined): DigestConfig {
	if (!config) {
		return {
			classifier: {
				provider: undefined,
				model: undefined,
				temperature: DEFAULT_TEMPERATURE,
				maxTokens: DEFAULT_MAX_TOKENS,
				concurrency: DEFAULT_CONCURRENCY,
			},
		};
	}

	const twitterClassifier = readTwitterDigestClassifier(config);
	const legacyClassifier = readLegacyDigestClassifier(config);

	const provider = readString(twitterClassifier.provider) ?? readString(legacyClassifier.provider);
	const model = readString(twitterClassifier.model) ?? readString(legacyClassifier.model);
	const temperatureRaw = twitterClassifier.temperature ?? legacyClassifier.temperature;
	const maxTokensRaw = twitterClassifier.maxTokens ?? legacyClassifier.maxTokens;
	const concurrencyRaw = twitterClassifier.concurrency ?? legacyClassifier.concurrency;

	return {
		classifier: {
			provider,
			model,
			temperature: normalizeNumber(temperatureRaw, DEFAULT_TEMPERATURE, { min: 0, max: 2 }),
			maxTokens: normalizeNumber(maxTokensRaw, DEFAULT_MAX_TOKENS, {
				integer: true,
				min: 1,
			}),
			concurrency: normalizeNumber(concurrencyRaw, DEFAULT_CONCURRENCY, {
				integer: true,
				min: 1,
				max: 16,
			}),
		},
	};
}