import type { DiscordAuthTokenRecord } from "./auth-store.js";

const DISCORD_OAUTH_TOKEN_URL = "https://discord.com/api/oauth2/token";

interface OAuthTokenPayload {
	access_token?: unknown;
	refresh_token?: unknown;
	token_type?: unknown;
	scope?: unknown;
	expires_in?: unknown;
	error?: unknown;
	error_description?: unknown;
	message?: unknown;
}

interface TokenExchangeBaseParams {
	clientId: string;
	clientSecret?: string;
	redirectUri?: string;
	scopes?: string[];
}

export interface AuthorizeCodeExchangeParams extends TokenExchangeBaseParams {
	code: string;
}

export interface RefreshTokenExchangeParams extends TokenExchangeBaseParams {
	refreshToken: string;
}

function readString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function toTokenRecord(payload: OAuthTokenPayload): Omit<DiscordAuthTokenRecord, "updatedAt"> | null {
	const accessToken = readString(payload.access_token);
	if (!accessToken) {
		return null;
	}

	let expiresAt: string | undefined;
	if (typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)) {
		expiresAt = new Date(Date.now() + Math.max(0, payload.expires_in) * 1000).toISOString();
	}

	return {
		accessToken,
		refreshToken: readString(payload.refresh_token),
		tokenType: readString(payload.token_type),
		scope: readString(payload.scope),
		expiresAt,
	};
}

function buildRequestBody(
	grantType: "authorization_code" | "refresh_token",
	params: AuthorizeCodeExchangeParams | RefreshTokenExchangeParams,
): URLSearchParams {
	const body = new URLSearchParams();
	body.set("client_id", params.clientId);
	body.set("grant_type", grantType);

	if (params.clientSecret) {
		body.set("client_secret", params.clientSecret);
	}
	if (params.redirectUri) {
		body.set("redirect_uri", params.redirectUri);
	}
	if (params.scopes && params.scopes.length > 0) {
		body.set("scope", params.scopes.join(" "));
	}

	if (grantType === "authorization_code") {
		body.set("code", (params as AuthorizeCodeExchangeParams).code);
	} else {
		body.set("refresh_token", (params as RefreshTokenExchangeParams).refreshToken);
	}

	return body;
}

async function exchangeToken(
	grantType: "authorization_code" | "refresh_token",
	params: AuthorizeCodeExchangeParams | RefreshTokenExchangeParams,
	strict: boolean,
): Promise<Omit<DiscordAuthTokenRecord, "updatedAt"> | null> {
	const response = await fetch(DISCORD_OAUTH_TOKEN_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: buildRequestBody(grantType, params),
	});

	let payload: OAuthTokenPayload = {};
	try {
		payload = (await response.json()) as OAuthTokenPayload;
	} catch {
		if (strict) {
			throw new Error(`discord oauth token exchange failed: HTTP ${response.status}`);
		}
		return null;
	}

	const token = toTokenRecord(payload);
	if (response.ok && token) {
		return token;
	}

	const message =
		readString(payload.error_description) ??
		readString(payload.message) ??
		readString(payload.error) ??
		`HTTP ${response.status}`;

	if (strict) {
		throw new Error(`discord oauth token exchange failed: ${message}`);
	}

	return null;
}

export async function exchangeDiscordAuthorizeCode(
	params: AuthorizeCodeExchangeParams,
): Promise<Omit<DiscordAuthTokenRecord, "updatedAt">> {
	const token = await exchangeToken("authorization_code", params, true);
	if (!token) {
		throw new Error("discord oauth authorization_code exchange returned no token");
	}
	return token;
}

export async function tryRefreshDiscordToken(
	params: RefreshTokenExchangeParams,
): Promise<Omit<DiscordAuthTokenRecord, "updatedAt"> | null> {
	return exchangeToken("refresh_token", params, false);
}