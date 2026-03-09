import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const DISCORD_SUBSCRIBE_EVENTS = [
	"MESSAGE_CREATE",
	"MESSAGE_UPDATE",
	"MESSAGE_DELETE",
] as const;

export type DiscordSubscribeEvent = (typeof DISCORD_SUBSCRIBE_EVENTS)[number];

export interface DiscordChannelConfig {
	id: string;
	alias?: string;
}

export interface DiscordCollectorConfig {
	enabled: boolean;
	clientId?: string;
	accessToken?: string;
	clientSecret?: string;
	redirectUri?: string;
	scopes: string[];
	channels: DiscordChannelConfig[];
	events: DiscordSubscribeEvent[];
	outputPath: string;
	includeRawPayload: boolean;
	maxReconnectDelayMs: number;
	systemEventBatchSize: number;
}

const DEFAULT_OUTPUT_PATH = join(homedir(), ".mono-pilot", "discord", "messages.jsonl");
const DEFAULT_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_SYSTEM_EVENT_BATCH_SIZE = 20;
const DEFAULT_SCOPES = ["rpc", "messages.read", "identify"];

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

function normalizeChannels(value: unknown): DiscordChannelConfig[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const seen = new Set<string>();
	const channels: DiscordChannelConfig[] = [];
	for (const item of value) {
		if (!isRecord(item)) {
			continue;
		}
		const id = readString(item.id);
		if (!id || seen.has(id)) {
			continue;
		}
		seen.add(id);
		const alias = readString(item.alias);
		channels.push(alias ? { id, alias } : { id });
	}

	return channels;
}

function normalizeScopes(value: unknown): string[] {
	const scopes = readStringArray(value);
	if (scopes.length > 0) {
		return scopes;
	}
	return [...DEFAULT_SCOPES];
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

function normalizeEvents(value: unknown): DiscordSubscribeEvent[] {
	const allowed = new Set<string>(DISCORD_SUBSCRIBE_EVENTS);
	const list = readStringArray(value)
		.map((item) => item.toUpperCase())
		.filter((item): item is DiscordSubscribeEvent => allowed.has(item));

	if (list.length === 0) {
		return ["MESSAGE_CREATE"];
	}

	return [...new Set(list)];
}

function normalizeReconnectDelay(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return DEFAULT_RECONNECT_DELAY_MS;
	}
	const normalized = Math.floor(value);
	if (normalized <= 0) {
		return DEFAULT_RECONNECT_DELAY_MS;
	}
	return normalized;
}

function normalizeSystemEventBatchSize(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return DEFAULT_SYSTEM_EVENT_BATCH_SIZE;
	}
	const normalized = Math.floor(value);
	if (normalized <= 0) {
		return DEFAULT_SYSTEM_EVENT_BATCH_SIZE;
	}
	return normalized;
}

export function extractDiscordCollectorConfig(
	config: Record<string, unknown> | undefined,
): DiscordCollectorConfig {
	if (!config || !isRecord(config.discord)) {
		return {
			enabled: false,
			scopes: [...DEFAULT_SCOPES],
			channels: [],
			events: ["MESSAGE_CREATE"],
			outputPath: DEFAULT_OUTPUT_PATH,
			includeRawPayload: false,
			maxReconnectDelayMs: DEFAULT_RECONNECT_DELAY_MS,
			systemEventBatchSize: DEFAULT_SYSTEM_EVENT_BATCH_SIZE,
		};
	}

	const discord = config.discord as Record<string, unknown>;
	const channels = normalizeChannels(discord.channels);
	const fallbackChannelIds = readStringArray(discord.channelIds);
	const normalizedChannels =
		channels.length > 0 ? channels : fallbackChannelIds.map((id) => ({ id } satisfies DiscordChannelConfig));

	return {
		enabled: discord.enabled === true,
		clientId: readString(discord.clientId),
		accessToken: readString(discord.accessToken),
		clientSecret: readString(discord.clientSecret),
		redirectUri: readString(discord.redirectUri),
		scopes: normalizeScopes(discord.scopes),
		channels: normalizedChannels,
		events: normalizeEvents(discord.events),
		outputPath: normalizeOutputPath(readString(discord.outputPath)),
		includeRawPayload: discord.includeRawPayload === true,
		maxReconnectDelayMs: normalizeReconnectDelay(discord.maxReconnectDelayMs),
		systemEventBatchSize: normalizeSystemEventBatchSize(discord.systemEventBatchSize),
	};
}