import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	formatSize,
	keyHint,
	truncateTail,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { McpServerError, resolveTargetServer, type TargetServer } from "../src/mcp/servers.js";
import { createRpcRequestId, formatJsonRpcError, initializeMcpSession, postJsonRpcRequest } from "../src/mcp/protocol.js";
import { formatErrorMessage, getHeaderKeys, isRecord, toBoolean, toNonEmptyString } from "../src/mcp/config.js";

const DESCRIPTION = `Call an MCP tool by server identifier and tool name with arbitrary JSON arguments. IMPORTANT: Always read the tool's schema/descriptor BEFORE calling to ensure correct parameters.

Example:
{
"server": "my-mcp-server",
"toolName": "search",
"arguments": { "query": "example", "limit": 10 }
}`;

const callMcpToolSchema = Type.Object({
	server: Type.String({ description: "Identifier of the MCP server hosting the tool." }),
	toolName: Type.String({ description: "Name of the MCP tool to invoke." }),
	arguments: Type.Optional(
		Type.Record(Type.String(), Type.Any(), {
			description: "JSON arguments object passed to the MCP tool.",
		}),
	),
});

type CallMcpToolInput = Static<typeof callMcpToolSchema>;

interface CallMcpToolDetails {
	config_paths?: string[];
	server: string;
	tool_name: string;
	transport?: "remote" | "stdio" | "unknown";
	server_url?: string;
	header_keys?: string[];
	session_id?: string;
	content_items?: number;
	is_error?: boolean;
	structured_content?: boolean;
	output_truncated?: boolean;
	error?: string;
}

async function callRemoteMcpTool(options: {
	serverUrl: string;
	serverHeaders: Record<string, string>;
	toolName: string;
	argumentsValue: Record<string, unknown>;
	signal: AbortSignal | undefined;
	toolCallId: string;
}): Promise<{ result: unknown; sessionId?: string }> {
	let sessionId = await initializeMcpSession(options);

	const callResponse = await postJsonRpcRequest({
		url: options.serverUrl,
		headers: options.serverHeaders,
		body: {
			jsonrpc: "2.0",
			id: createRpcRequestId(`${options.toolCallId}:tools.call`),
			method: "tools/call",
			params: {
				name: options.toolName,
				arguments: options.argumentsValue,
			},
		},
		parentSignal: options.signal,
		sessionId,
		expectResponseBody: true,
	});

	sessionId = callResponse.sessionId ?? sessionId;

	const callBody = callResponse.parsedBody;
	if (callBody?.error) {
		throw new Error(formatJsonRpcError(callBody.error, "MCP tools/call failed."));
	}
	if (!callBody || callBody.result === undefined) {
		throw new Error("MCP tools/call returned no result.");
	}

	return { result: callBody.result, sessionId };
}

function normalizeServerName(value: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error("server is required.");
	return normalized;
}

function normalizeToolName(value: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error("toolName is required.");
	return normalized;
}

function normalizeArguments(value: Record<string, unknown> | undefined): Record<string, unknown> {
	if (!value) return {};
	if (!isRecord(value)) throw new Error("arguments must be a JSON object.");
	return value;
}

function formatToolCallResultOutput(server: string, toolName: string, result: unknown): {
	text: string;
	contentItems: number;
	isError: boolean;
	hasStructuredContent: boolean;
} {
	const lines: string[] = [];
	let contentItems = 0;
	let isError = false;
	let hasStructuredContent = false;

	lines.push(`Server: ${server}`);
	lines.push(`Tool: ${toolName}`);

	if (isRecord(result)) {
		isError = toBoolean(result.isError) ?? false;
		const content = Array.isArray(result.content) ? result.content : [];
		contentItems = content.length;
		lines.push(`isError: ${isError ? "true" : "false"}`);
		lines.push(`Content items: ${contentItems}`);

		if (contentItems > 0) {
			for (let i = 0; i < content.length; i++) {
				const entry = content[i];
				lines.push("");
				lines.push(`## Item ${i + 1}`);

				if (!isRecord(entry)) {
					lines.push("```json");
					lines.push(JSON.stringify(entry, null, 2));
					lines.push("```");
					continue;
				}

				const type = toNonEmptyString(entry.type) ?? "unknown";
				lines.push(`type: ${type}`);

				if (type === "text" && typeof entry.text === "string") {
					lines.push(entry.text);
					continue;
				}

				if (type === "image") {
					const mimeType = toNonEmptyString(entry.mimeType) ?? "unknown";
					const data = typeof entry.data === "string" ? entry.data : "";
					lines.push(`[Image content mime=${mimeType} data_chars=${data.length}]`);
					continue;
				}

				if (type === "resource" && isRecord(entry.resource)) {
					const resourceText = typeof entry.resource.text === "string" ? entry.resource.text : undefined;
					if (resourceText) {
						lines.push(resourceText);
						continue;
					}
				}

				lines.push("```json");
				lines.push(JSON.stringify(entry, null, 2));
				lines.push("```");
			}
		}

		if (result.structuredContent !== undefined) {
			hasStructuredContent = true;
			lines.push("");
			lines.push("## Structured Content");
			lines.push("```json");
			lines.push(JSON.stringify(result.structuredContent, null, 2));
			lines.push("```");
		}

		if (contentItems === 0 && !hasStructuredContent) {
			lines.push("");
			lines.push("Raw result:");
			lines.push("```json");
			lines.push(JSON.stringify(result, null, 2));
			lines.push("```");
		}
	} else {
		lines.push("isError: false");
		lines.push("Content items: 0");
		lines.push("");
		lines.push("Raw result:");
		lines.push("```json");
		lines.push(JSON.stringify(result, null, 2));
		lines.push("```");
	}

	return { text: lines.join("\n"), contentItems, isError, hasStructuredContent };
}

function getCollapsedResultText(text: string, expanded: boolean): { output: string; remaining: number } {
	if (text.length === 0) return { output: text, remaining: 0 };

	const lines = text.split("\n");
	const MAX_COLLAPSED_RESULT_LINES = 20;

	if (expanded || lines.length <= MAX_COLLAPSED_RESULT_LINES) {
		return { output: text, remaining: 0 };
	}

	return {
		output: lines.slice(0, MAX_COLLAPSED_RESULT_LINES).join("\n"),
		remaining: lines.length - MAX_COLLAPSED_RESULT_LINES,
	};
}

export default function callMcpToolExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "CallMcpTool",
		label: "CallMcpTool",
		description: DESCRIPTION,
		parameters: callMcpToolSchema,
		renderCall(args, theme) {
			const server = typeof args.server === "string" ? args.server : "(missing server)";
			const toolName = typeof args.toolName === "string" ? args.toolName : "(missing tool)";
			let text = theme.fg("toolTitle", theme.bold("CallMcpTool"));
			text += ` ${theme.fg("toolOutput", `${server} :: ${toolName}`)}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("muted", "Calling MCP tool..."), 0, 0);
			}

			const textBlock = result.content.find((entry): entry is any => entry.type === "text" && typeof (entry as any).text === "string");
			if (!textBlock || typeof textBlock.text !== "string") {
				return new Text(theme.fg("error", "No text result returned."), 0, 0);
			}

			const { output, remaining } = getCollapsedResultText(textBlock.text, expanded);
			const isErrorResult = (result as any).isError === true || (result.details as any)?.is_error === true;
			let text = output
				.split("\n")
				.map((line) => (isErrorResult ? theme.fg("error", line) : theme.fg("toolOutput", line)))
				.join("\n");

			if (!expanded && remaining > 0) {
				text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("expandTools", "to expand")})`;
			}

			return new Text(text, 0, 0);
		},
		async execute(toolCallId, params: CallMcpToolInput, signal, _onUpdate, ctx) {
			let serverName: string;
			let toolName: string;
			let argumentsValue: Record<string, unknown>;

			try {
				serverName = normalizeServerName(params.server);
				toolName = normalizeToolName(params.toolName);
				argumentsValue = normalizeArguments(params.arguments);
			} catch (error) {
				const message = formatErrorMessage(error);
				return {
					content: [{ type: "text", text: message }],
					details: {
						server: params.server,
						tool_name: params.toolName,
						error: message,
					} satisfies CallMcpToolDetails,
					isError: true,
				};
			}

			let server: TargetServer;
			let configPaths: string[];

			try {
				const result = await resolveTargetServer(ctx.cwd, serverName);
				server = result.server;
				configPaths = result.configPaths;
			} catch (error) {
				const message = formatErrorMessage(error);
				const transport = error instanceof McpServerError ? error.transport : undefined;
				const paths = error instanceof McpServerError ? error.configPaths : undefined;
				return {
					content: [{ type: "text", text: message }],
					details: {
						config_paths: paths,
						server: serverName,
						tool_name: toolName,
						transport,
						error: message,
					} satisfies CallMcpToolDetails,
					isError: true,
				};
			}

			try {
				const remoteResult = await callRemoteMcpTool({
					serverUrl: server.url,
					serverHeaders: server.headers,
					toolName,
					argumentsValue,
					signal,
					toolCallId,
				});

				const formatted = formatToolCallResultOutput(serverName, toolName, remoteResult.result);
				const truncation = truncateTail(formatted.text, {
					maxBytes: DEFAULT_MAX_BYTES,
					maxLines: DEFAULT_MAX_LINES,
				});

				let output = truncation.content;
				if (truncation.truncated) {
					output += `\n\n[Output truncated to ${formatSize(DEFAULT_MAX_BYTES)} / ${DEFAULT_MAX_LINES} lines.]`;
				}

				return {
					content: [{ type: "text", text: output }],
					details: {
						config_paths: configPaths,
						server: serverName,
						tool_name: toolName,
						transport: "remote",
						server_url: server.url,
						header_keys: getHeaderKeys(server.headers),
						session_id: remoteResult.sessionId,
						content_items: formatted.contentItems,
						is_error: formatted.isError,
						structured_content: formatted.hasStructuredContent,
						output_truncated: truncation.truncated || undefined,
					} satisfies CallMcpToolDetails,
					isError: formatted.isError,
				};
			} catch (error) {
				const message = formatErrorMessage(error);
				return {
					content: [{ type: "text", text: `CallMcpTool failed: ${message}` }],
					details: {
						config_paths: configPaths,
						server: serverName,
						tool_name: toolName,
						transport: "remote",
						server_url: server.url,
						header_keys: getHeaderKeys(server.headers),
						error: message,
					} satisfies CallMcpToolDetails,
					isError: true,
				};
			}
		},
	});
}
