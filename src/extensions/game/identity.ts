import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const PROFILE_FILE = "profile.json";
const IDENTITY_FILE = "identity.md";

interface IdentityProfile {
	displayName?: unknown;
	tools?: unknown;
}

export interface GameIdentity {
	displayName: string;
	identityPrompt?: string;
	profilePath: string;
	identityPath: string;
	tools?: string[];
}

export function getGameChannel(workspaceCwd: string, channelOverride?: string): string {
	const override = channelOverride?.trim();
	if (override) return override;
	const hash = createHash("sha1").update(workspaceCwd).digest("hex").slice(0, 10);
	return `game:${hash}`;
}

export function getGameGmChannel(gameChannel: string): string {
	return `${gameChannel}:gm`;
}

function parseProfile(path: string): IdentityProfile {
	if (!existsSync(path)) return {};
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw) as IdentityProfile;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function readIdentityPrompt(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const raw = readFileSync(path, "utf-8").trim();
		return raw.length > 0 ? raw : undefined;
	} catch {
		return undefined;
	}
}

function extractDisplayNameFromIdentity(identityPrompt: string | undefined): string | undefined {
	if (!identityPrompt) return undefined;
	for (const line of identityPrompt.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		const match = trimmed.match(/^角色\s*[：:]\s*(.+)$/);
		if (match?.[1]) return match[1].trim();
	}
	return undefined;
}

export function loadGameIdentity(workspaceCwd: string): GameIdentity {
	const profilePath = resolve(workspaceCwd, PROFILE_FILE);
	const identityPath = resolve(workspaceCwd, IDENTITY_FILE);

	const profile = parseProfile(profilePath);
	const identityPrompt = readIdentityPrompt(identityPath);
	const fromProfile = typeof profile.displayName === "string" ? profile.displayName.trim() : "";
	const fromIdentity = extractDisplayNameFromIdentity(identityPrompt);
	const fallback = basename(workspaceCwd);
	const tools = resolveToolList(profile);

	const displayName = fromProfile || fromIdentity || fallback;

	return {
		displayName,
		identityPrompt,
		profilePath,
		identityPath,
		tools,
	};
}

function resolveToolList(profile: IdentityProfile): string[] | undefined {
	const hasTools = typeof profile === "object" && profile !== null && "tools" in profile;
	if (!hasTools) return undefined;
	const raw = (profile as { tools?: unknown }).tools;
	if (!Array.isArray(raw)) {
		console.warn("[mono-game] profile.tools must be an array of strings");
		return [];
	}
	return raw
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.trim())
		.filter(Boolean);
}
