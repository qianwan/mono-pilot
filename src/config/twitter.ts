import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface TwitterCollectorConfig {
	enabled: boolean;
	outputPath: string;
	pullIntervalMinutes: number;
	pullCount: number;
	includeRawPayload: boolean;
	commandTimeoutMs: number;
	requestTimeoutMs?: number;
	chromeProfile?: string;
	chromeProfileDir?: string;
	firefoxProfile?: string;
	cookieSource: string[];
	cookieTimeoutMs?: number;
}

const DEFAULT_OUTPUT_PATH = join(homedir(), ".mono-pilot", "twitter", "home.jsonl");
const DEFAULT_PULL_INTERVAL_MINUTES = 10;
const DEFAULT_PULL_COUNT = 10;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

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

function readStringArray(value: unknown): string[] {
	if (typeof value === "string") {
		const values = value
			.split(/\s+/)
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
		return [...new Set(values)];
	}

	if (!Array.isArray(value)) {
		return [];
	}

	const values = value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	return [...new Set(values)];
}

function normalizeOutputPath(rawPath: string | undefined): string {
	if (!rawPath) {
		return DEFAULT_OUTPUT_PATH;
	}

	let expanded = rawPath;
	if (expanded === "~") {
		expanded = homedir();
	} else if (expanded.startsWith("~/")) {
		expanded = join(homedir(), expanded.slice(2));
	}

	if (isAbsolute(expanded)) {
		return expanded;
	}

	return resolve(expanded);
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	const normalized = Math.floor(value);
	if (normalized <= 0) {
		return fallback;
	}
	return normalized;
}

function normalizeOptionalPositiveInteger(value: unknown): number | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return undefined;
	}
	const normalized = Math.floor(value);
	if (normalized <= 0) {
		return undefined;
	}
	return normalized;
}

export function extractTwitterCollectorConfig(
	config: Record<string, unknown> | undefined,
): TwitterCollectorConfig {
	if (!config || !isRecord(config.twitter)) {
		return {
			enabled: false,
			outputPath: DEFAULT_OUTPUT_PATH,
			pullIntervalMinutes: DEFAULT_PULL_INTERVAL_MINUTES,
			pullCount: DEFAULT_PULL_COUNT,
			includeRawPayload: false,
			commandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
			cookieSource: [],
		};
	}

	const twitter = config.twitter as Record<string, unknown>;
	return {
		enabled: twitter.enabled === true,
		outputPath: normalizeOutputPath(readString(twitter.outputPath)),
		pullIntervalMinutes: normalizePositiveInteger(
			twitter.pullIntervalMinutes,
			DEFAULT_PULL_INTERVAL_MINUTES,
		),
		pullCount: normalizePositiveInteger(twitter.pullCount, DEFAULT_PULL_COUNT),
		includeRawPayload: twitter.includeRawPayload === true,
		commandTimeoutMs: normalizePositiveInteger(twitter.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS),
		requestTimeoutMs: normalizeOptionalPositiveInteger(twitter.requestTimeoutMs),
		chromeProfile: readString(twitter.chromeProfile),
		chromeProfileDir: readString(twitter.chromeProfileDir),
		firefoxProfile: readString(twitter.firefoxProfile),
		cookieSource: readStringArray(twitter.cookieSource),
		cookieTimeoutMs: normalizeOptionalPositiveInteger(twitter.cookieTimeoutMs),
	};
}