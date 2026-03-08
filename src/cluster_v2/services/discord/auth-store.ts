import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const AUTH_PATH = join(homedir(), ".mono-pilot", "auth.json");

export interface DiscordAuthTokenRecord {
	accessToken: string;
	refreshToken?: string;
	tokenType?: string;
	scope?: string;
	expiresAt?: string;
	updatedAt: string;
}

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

async function loadAuthObject(): Promise<Record<string, unknown>> {
	if (!existsSync(AUTH_PATH)) {
		return {};
	}

	const raw = await readFile(AUTH_PATH, "utf-8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid JSON in auth store: ${message}`);
	}

	if (!isRecord(parsed)) {
		throw new Error("Auth store root must be a JSON object.");
	}

	return parsed;
}

function normalizeToken(value: Record<string, unknown>): DiscordAuthTokenRecord | null {
	const accessToken = readString(value.accessToken);
	if (!accessToken) {
		return null;
	}

	return {
		accessToken,
		refreshToken: readString(value.refreshToken),
		tokenType: readString(value.tokenType),
		scope: readString(value.scope),
		expiresAt: readString(value.expiresAt),
		updatedAt: readString(value.updatedAt) ?? new Date(0).toISOString(),
	};
}

export function getAuthStorePath(): string {
	return AUTH_PATH;
}

export async function readDiscordAuthToken(clientId: string): Promise<DiscordAuthTokenRecord | null> {
	const root = await loadAuthObject();
	const discord = isRecord(root.discord) ? root.discord : null;
	const tokens = discord && isRecord(discord.tokens) ? discord.tokens : null;
	if (!tokens) {
		return null;
	}

	const raw = tokens[clientId];
	if (!isRecord(raw)) {
		return null;
	}

	return normalizeToken(raw);
}

export async function writeDiscordAuthToken(
	clientId: string,
	token: Omit<DiscordAuthTokenRecord, "updatedAt">,
): Promise<DiscordAuthTokenRecord> {
	const root = await loadAuthObject();
	const discord: Record<string, unknown> = isRecord(root.discord) ? { ...root.discord } : {};
	const tokens: Record<string, unknown> = isRecord(discord.tokens) ? { ...discord.tokens } : {};

	const normalized: DiscordAuthTokenRecord = {
		accessToken: token.accessToken,
		refreshToken: token.refreshToken,
		tokenType: token.tokenType,
		scope: token.scope,
		expiresAt: token.expiresAt,
		updatedAt: new Date().toISOString(),
	};

	tokens[clientId] = normalized;
	discord.tokens = tokens;
	root.discord = discord;

	await mkdir(dirname(AUTH_PATH), { recursive: true });
	await writeFile(AUTH_PATH, `${JSON.stringify(root, null, 2)}\n`, "utf-8");
	return normalized;
}