import { formatErrorMessage, isRecord, toNonEmptyString } from "./config.js";

export const MCP_PROTOCOL_VERSION = "2025-03-26";
export const MCP_CLIENT_NAME = "mono-pilot";
export const MCP_CLIENT_VERSION = "0.1.0";
export const MCP_REQUEST_TIMEOUT_MS = 20_000;

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
