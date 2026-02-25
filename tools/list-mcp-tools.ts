import { homedir } from "node:os";
import { resolve } from "node:path";
import { type ExtensionAPI, keyHint } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import {
	createRpcRequestId,
	extractStringHeaders,
	formatErrorMessage,
	formatJsonRpcError,
	inferTransport,
	isRecord,
	isServerEnabled,
	MCP_CONFIG_RELATIVE_PATH,
	parseMcpConfig,
	postJsonRpcRequest,
	resolveMcpConfigPath,
	toNonEmptyString,
	initializeMcpSession,
	type RawMcpServerConfig,
} from "../src/utils/mcp-client.js";

const DESCRIPTION = `List available MCP tools from configured MCP servers. Each returned tool includes server metadata. If server is provided, results are limited to that server. If toolName is provided, returns full documentation and input JSON schema for matching tools.`;

const listMcpToolsSchema = Type.Object({
	server: Type.Optional(
		Type.String({
			description: "Optional server identifier to filter tools. If omitted, list tools from all configured servers.",
		}),
	),
	toolName: Type.Optional(
		Type.String({
			description:
				"Optional exact tool name to inspect. When provided, returns full tool documentation and input JSON schema for matches.",
		}),
	),
});

type ListMcpToolsInput = Static<typeof listMcpToolsSchema>;

interface ListMcpToolsDetails {
	config_path?: string;
	servers_matched?: number;
	servers_queried?: number;
	servers_failed?: number;
	total_tools?: number;
	error?: string;
}

interface McpTool {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

interface McpToolListResult {
	tools: McpTool[];
	nextCursor?: string;
}

async function listRemoteMcpTools(options: {
	serverUrl: string;
	serverHeaders: Record<string, string>;
	signal: AbortSignal | undefined;
	toolCallId: string;
}): Promise<McpToolListResult> {
	let sessionId = await initializeMcpSession(options);

	const response = await postJsonRpcRequest({
		url: options.serverUrl,
		headers: options.serverHeaders,
		body: {
			jsonrpc: "2.0",
			id: createRpcRequestId(`${options.toolCallId}:tools.list`),
			method: "tools/list",
			params: {},
		},
		parentSignal: options.signal,
		sessionId,
		expectResponseBody: true,
	});

	const body = response.parsedBody;
	if (body?.error) {
		throw new Error(formatJsonRpcError(body.error, "MCP tools/list failed."));
	}
	if (!body || !isRecord(body.result)) {
		throw new Error("MCP tools/list returned invalid result.");
	}

	const rawTools = body.result.tools;
	if (!Array.isArray(rawTools)) {
		throw new Error("MCP tools/list result.tools is not an array.");
	}

	const tools: McpTool[] = [];
	for (const raw of rawTools) {
		if (!isRecord(raw)) continue;
		const name = toNonEmptyString(raw.name);
		if (!name) continue;

		tools.push({
			name,
			description: toNonEmptyString(raw.description),
			inputSchema: raw.inputSchema,
		});
	}

	return {
		tools,
		nextCursor: toNonEmptyString(body.result.nextCursor),
	};
}

function normalizeOptionalString(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized || undefined;
}

export default function listMcpToolsExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ListMcpTools",
		label: "ListMcpTools",
		description: DESCRIPTION,
		parameters: listMcpToolsSchema,
		async execute(toolCallId, params: ListMcpToolsInput, signal, _onUpdate, ctx) {
			let serverFilter: string | undefined;
			let toolNameFilter: string | undefined;

			try {
				serverFilter = normalizeOptionalString(params.server);
				toolNameFilter = normalizeOptionalString(params.toolName);
			} catch (error) {
				const message = formatErrorMessage(error);
				return {
					content: [{ type: "text", text: message }],
					details: { error: message } satisfies ListMcpToolsDetails,
					isError: true,
				};
			}

			const configPath = resolveMcpConfigPath(ctx.cwd);
			if (!configPath) {
				const workspaceCandidate = resolve(ctx.cwd, MCP_CONFIG_RELATIVE_PATH);
				const homeCandidate = resolve(homedir(), MCP_CONFIG_RELATIVE_PATH);
				const message = `MCP config not found. Checked:\n- ${workspaceCandidate}\n- ${homeCandidate}`;
				return {
					content: [{ type: "text", text: message }],
					details: { error: message } satisfies ListMcpToolsDetails,
					isError: true,
				};
			}

			let servers: Record<string, RawMcpServerConfig>;
			try {
				servers = await parseMcpConfig(configPath);
			} catch (error) {
				const message = formatErrorMessage(error);
				return {
					content: [{ type: "text", text: message }],
					details: {
						config_path: configPath,
						error: message,
					} satisfies ListMcpToolsDetails,
					isError: true,
				};
			}

			const targetServers: Array<{ name: string; url: string; headers: Record<string, string> }> = [];

			for (const [serverName, serverConfig] of Object.entries(servers)) {
				if (serverFilter && serverName !== serverFilter) continue;
				if (!isServerEnabled(serverConfig)) continue;
				if (inferTransport(serverConfig) !== "remote") continue;
				const serverUrl = toNonEmptyString(serverConfig.url);
				if (!serverUrl) continue;
				targetServers.push({
					name: serverName,
					url: serverUrl,
					headers: extractStringHeaders(serverConfig.headers),
				});
			}

			if (targetServers.length === 0) {
				const message = serverFilter
					? `No active remote MCP server found matching '${serverFilter}'.`
					: "No active remote MCP servers found in config.";
				return {
					content: [{ type: "text", text: message }],
					details: {
						config_path: configPath,
						servers_matched: 0,
					} satisfies ListMcpToolsDetails,
				};
			}

			const lines: string[] = [];
			lines.push(`MCP config: ${configPath}`);
			lines.push(`Servers matched: ${targetServers.length}`);
			if (serverFilter) lines.push(`Server filter: ${serverFilter}`);
			if (toolNameFilter) lines.push(`Tool filter: ${toolNameFilter}`);
			lines.push("");

			let totalTools = 0;
			let serversFailed = 0;

			for (const target of targetServers) {
				try {
					const result = await listRemoteMcpTools({
						serverUrl: target.url,
						serverHeaders: target.headers,
						signal,
						toolCallId,
					});

					const matchedTools = toolNameFilter
						? result.tools.filter((t) => t.name === toolNameFilter)
						: result.tools;

					if (matchedTools.length === 0) {
						if (serverFilter) {
							lines.push(`## [${target.name}]`);
							lines.push("(no matching tools)");
							lines.push("");
						}
						continue;
					}

					if (toolNameFilter) {
						// Detailed mode
						for (const tool of matchedTools) {
							totalTools++;
							lines.push(`## [${target.name}] ${tool.name}`);
							lines.push("");
							if (tool.description) {
								lines.push("### Documentation");
								lines.push(tool.description);
								lines.push("");
							}
							if (tool.inputSchema) {
								lines.push("### Input Signature JSON Schema");
								lines.push("```json");
								lines.push(JSON.stringify(tool.inputSchema, null, 2));
								lines.push("```");
								lines.push("");
							}
						}
					} else {
						// Summary mode
						lines.push(`Tools returned: ${matchedTools.length}`);
						lines.push("");
						for (const tool of matchedTools) {
							totalTools++;
							let desc = "";
							if (tool.description) {
								const firstLine = tool.description.split("\n")[0]?.trim();
								if (firstLine) {
									const truncated = firstLine.length > 150 ? `${firstLine.slice(0, 147)}...` : firstLine;
									desc = `\n  ${truncated}`;
								}
							}
							lines.push(`- [${target.name}] ${tool.name}${desc}`);
						}
						if (result.nextCursor) {
							lines.push("");
							lines.push(`(additional tools available, nextCursor: ${result.nextCursor})`);
						}
					}
				} catch (error) {
					serversFailed++;
					lines.push(`## [${target.name}]`);
					lines.push(`Error listing tools: ${formatErrorMessage(error)}`);
					lines.push("");
				}
			}

			return {
				content: [{ type: "text", text: lines.join("\n").trim() }],
				details: {
					config_path: configPath,
					servers_matched: targetServers.length,
					servers_queried: targetServers.length,
					servers_failed: serversFailed,
					total_tools: totalTools,
				} satisfies ListMcpToolsDetails,
			};
		},
	});
}
