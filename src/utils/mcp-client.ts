import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";

export const MCP_CONFIG_RELATIVE_PATH = join(".pi", "mcp.json");
export const MCP_PROTOCOL_VERSION = "2025-03-26";
export const MCP_CLIENT_NAME = "mono-pilot";
export const MCP_CLIENT_VERSION = "0.1.0";
export const MCP_REQUEST_TIMEOUT_MS = 20_000;

export interface RawMcpServerConfig {
	url?: unknown;
	command?: unknown;
	args?: unknown;
	headers?: unknown;
	env?: unknown;
	enabled?: unknown;
	disabled?: unknown;
}

export interface JsonRpcErrorObject {
	code?: number;
	message?: string;
	data?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc?: string;
	id?: string | number;
	result?: unknown;
	error?: JsonRpcErrorObject;
}

export interface RemoteCallResult {
	parsedBody?: JsonRpcResponse;
	rawBody: string;
	sessionId?: string;
	status: number;
	contentType?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function toNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	return trimmed;
}

export function toBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	return undefined;
}

export function formatErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

export function resolveMcpConfigPath(workspaceCwd: string): string | undefined {
	const envOverride = toNonEmptyString(process.env.MONOPILOT_MCP_CONFIG);
	const candidates: string[] = [];

	if (envOverride) {
		candidates.push(isAbsolute(envOverride) ? resolve(envOverride) : resolve(workspaceCwd, envOverride));
	}

	candidates.push(resolve(workspaceCwd, MCP_CONFIG_RELATIVE_PATH));
	candidates.push(resolve(homedir(), MCP_CONFIG_RELATIVE_PATH));

	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}

	return undefined;
}

export async function parseMcpConfig(configPath: string): Promise<Record<string, RawMcpServerConfig>> {
	const rawText = await readFile(configPath, "utf-8");
	return _parseMcpConfigContent(rawText, configPath);
}

function _parseMcpConfigContent(rawText: string, configPath: string): Record<string, RawMcpServerConfig> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawText);
	} catch (error) {
		throw new Error(`Invalid JSON in MCP config: ${formatErrorMessage(error)}`);
	}

	if (!isRecord(parsed)) {
		throw new Error("MCP config root must be a JSON object.");
	}

	const serversValue = parsed.mcpServers;
	if (!isRecord(serversValue)) return {};

	const result: Record<string, RawMcpServerConfig> = {};
	for (const [serverName, serverConfig] of Object.entries(serversValue)) {
		if (!isRecord(serverConfig)) continue;
		result[serverName] = serverConfig as RawMcpServerConfig;
	}

	return result;
}

export function isServerEnabled(config: RawMcpServerConfig): boolean {
	const disabled = toBoolean(config.disabled);
	if (disabled === true) return false;

	const enabled = toBoolean(config.enabled);
	if (enabled === false) return false;

	return true;
}

export function inferTransport(config: RawMcpServerConfig): "remote" | "stdio" | "unknown" {
	if (toNonEmptyString(config.url)) return "remote";
	if (toNonEmptyString(config.command)) return "stdio";
	return "unknown";
}

export function extractStringHeaders(rawHeaders: unknown): Record<string, string> {
	if (!isRecord(rawHeaders)) return {};
	const headers: Record<string, string> = {};

	for (const [key, value] of Object.entries(rawHeaders)) {
		const headerName = key.trim();
		if (!headerName) continue;
		if (typeof value === "string") headers[headerName] = value;
	}

	return headers;
}

export function getHeaderKeys(headers: Record<string, string>): string[] | undefined {
	const keys = Object.keys(headers).sort((a, b) => a.localeCompare(b));
	return keys.length > 0 ? keys : undefined;
}

export function parseSseJsonPayload(rawBody: string): JsonRpcResponse | undefined {
	const lines = rawBody.split(/\r?\n/);
	const events: string[] = [];
	let currentDataLines: string[] = [];

	for (const line of lines) {
		if (line.length === 0) {
			if (currentDataLines.length > 0) {
				events.push(currentDataLines.join("\n"));
				currentDataLines = [];
			}
			continue;
		}

		if (line.startsWith("data:")) {
			currentDataLines.push(line.slice(5).trimStart());
		}
	}

	if (currentDataLines.length > 0) {
		events.push(currentDataLines.join("\n"));
	}

	let parsed: JsonRpcResponse | undefined;
	for (const eventData of events) {
		if (!eventData || eventData === "[DONE]") continue;
		try {
			const candidate = JSON.parse(eventData) as unknown;
			if (isRecord(candidate)) parsed = candidate as JsonRpcResponse;
		} catch {
			// Ignore malformed SSE chunks.
		}
	}

	return parsed;
}

export function parseJsonRpcBody(rawBody: string, contentType: string | undefined): JsonRpcResponse | undefined {
	const trimmed = rawBody.trim();
	if (trimmed.length === 0) return undefined;

	if (contentType?.includes("text/event-stream")) {
		const sseParsed = parseSseJsonPayload(rawBody);
		if (sseParsed) return sseParsed;
	}

	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (isRecord(parsed)) return parsed as JsonRpcResponse;
	} catch {
		const sseParsed = parseSseJsonPayload(rawBody);
		if (sseParsed) return sseParsed;
	}

	return undefined;
}

export function formatJsonRpcError(error: JsonRpcErrorObject | undefined, fallback: string): string {
	if (!error) return fallback;
	const codePart = typeof error.code === "number" ? ` (code ${error.code})` : "";
	const messagePart = toNonEmptyString(error.message) ?? fallback;
	return `${messagePart}${codePart}`;
}

export function createRpcRequestId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function postJsonRpcRequest(options: {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
	parentSignal: AbortSignal | undefined;
	sessionId?: string;
	expectResponseBody: boolean;
	timeoutMs?: number;
}): Promise<RemoteCallResult> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs ?? MCP_REQUEST_TIMEOUT_MS);

	const onAbort = () => controller.abort();
	options.parentSignal?.addEventListener("abort", onAbort, { once: true });

	try {
		const requestHeaders: Record<string, string> = {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...options.headers,
		};

		if (options.sessionId) {
			requestHeaders["mcp-session-id"] = options.sessionId;
		}

		const response = await fetch(options.url, {
			method: "POST",
			headers: requestHeaders,
			body: JSON.stringify(options.body),
			signal: controller.signal,
		});

		const rawBody = await response.text();
		const contentType = toNonEmptyString(response.headers.get("content-type") ?? undefined);
		const parsedBody = parseJsonRpcBody(rawBody, contentType);
		const responseSessionId =
			toNonEmptyString(response.headers.get("mcp-session-id") ?? undefined) ??
			toNonEmptyString(response.headers.get("Mcp-Session-Id") ?? undefined);

		if (!response.ok) {
			const fallback = `Remote MCP request failed with status ${response.status}.`;
			const errorText = formatJsonRpcError(parsedBody?.error, fallback) || toNonEmptyString(rawBody) || fallback;
			throw new Error(errorText);
		}

		if (options.expectResponseBody && !parsedBody) {
			throw new Error("Remote MCP response did not contain a JSON-RPC body.");
		}

		return {
			parsedBody,
			rawBody,
			sessionId: responseSessionId,
			status: response.status,
			contentType,
		};
	} finally {
		clearTimeout(timeoutId);
		options.parentSignal?.removeEventListener("abort", onAbort);
	}
}

export async function initializeMcpSession(options: {
	serverUrl: string;
	serverHeaders: Record<string, string>;
	toolCallId: string;
	signal: AbortSignal | undefined;
}): Promise<string | undefined> {
	const initializeResponse = await postJsonRpcRequest({
		url: options.serverUrl,
		headers: options.serverHeaders,
		body: {
			jsonrpc: "2.0",
			id: createRpcRequestId(`${options.toolCallId}:initialize`),
			method: "initialize",
			params: {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: {
					name: MCP_CLIENT_NAME,
					version: MCP_CLIENT_VERSION,
				},
			},
		},
		parentSignal: options.signal,
		expectResponseBody: true,
	});

	const initializeBody = initializeResponse.parsedBody;
	if (initializeBody?.error) {
		throw new Error(formatJsonRpcError(initializeBody.error, "MCP initialize failed."));
	}
	if (!initializeBody || initializeBody.result === undefined) {
		throw new Error("MCP initialize did not return a result.");
	}

	let sessionId = initializeResponse.sessionId;

	try {
		const initializedNotification = await postJsonRpcRequest({
			url: options.serverUrl,
			headers: options.serverHeaders,
			body: {
				jsonrpc: "2.0",
				method: "notifications/initialized",
				params: {},
			},
			parentSignal: options.signal,
			sessionId,
			expectResponseBody: false,
		});
		sessionId = initializedNotification.sessionId ?? sessionId;
	} catch {
		// Best effort compatibility.
	}

	return sessionId;
}
