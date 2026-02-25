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

const DESCRIPTION = `List available resources from configured MCP servers. Each returned resource will include all standard MCP resource fields plus a 'server' field indicating which server the resource belongs to. MCP resources are _not_ the same as tools, so don't call this function to discover MCP tools.`;

const listMcpResourcesSchema = Type.Object({
	server: Type.Optional(
		Type.String({
			description:
				"Optional server identifier to filter resources by. If not provided, resources from all servers will be returned.",
		}),
	),
});

type ListMcpResourcesInput = Static<typeof listMcpResourcesSchema>;

interface ListMcpResourcesDetails {
	config_path?: string;
	servers_matched?: number;
	servers_queried?: number;
	servers_failed?: number;
	total_resources?: number;
	error?: string;
}

interface McpResource {
	uri: string;
	name: string;
	description?: string;
	mimeType?: string;
}

interface McpResourceListResult {
	resources: McpResource[];
	nextCursor?: string;
}

async function listRemoteMcpResources(options: {
	serverUrl: string;
	serverHeaders: Record<string, string>;
	signal: AbortSignal | undefined;
	toolCallId: string;
}): Promise<McpResourceListResult> {
	let sessionId = await initializeMcpSession(options);

	const resourcesResponse = await postJsonRpcRequest({
		url: options.serverUrl,
		headers: options.serverHeaders,
		body: {
			jsonrpc: "2.0",
			id: createRpcRequestId(`${options.toolCallId}:resources.list`),
			method: "resources/list",
			params: {},
		},
		parentSignal: options.signal,
		sessionId,
		expectResponseBody: true,
	});

	const resourcesBody = resourcesResponse.parsedBody;
	if (resourcesBody?.error) {
		throw new Error(formatJsonRpcError(resourcesBody.error, "MCP resources/list failed."));
	}
	if (!resourcesBody || !isRecord(resourcesBody.result)) {
		throw new Error("MCP resources/list returned invalid result.");
	}

	const rawResources = resourcesBody.result.resources;
	if (!Array.isArray(rawResources)) {
		throw new Error("MCP resources/list result.resources is not an array.");
	}

	const resources: McpResource[] = [];
	for (const raw of rawResources) {
		if (!isRecord(raw)) continue;
		const uri = toNonEmptyString(raw.uri);
		const name = toNonEmptyString(raw.name);
		if (!uri || !name) continue;

		resources.push({
			uri,
			name,
			description: toNonEmptyString(raw.description),
			mimeType: toNonEmptyString(raw.mimeType),
		});
	}

	return {
		resources,
		nextCursor: toNonEmptyString(resourcesBody.result.nextCursor),
	};
}

function normalizeServerFilter(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized || undefined;
}

export default function listMcpResourcesExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ListMcpResources",
		label: "ListMcpResources",
		description: DESCRIPTION,
		parameters: listMcpResourcesSchema,
		async execute(toolCallId, params: ListMcpResourcesInput, signal, _onUpdate, ctx) {
			let serverFilter: string | undefined;

			try {
				serverFilter = normalizeServerFilter(params.server);
			} catch (error) {
				const message = formatErrorMessage(error);
				return {
					content: [{ type: "text", text: message }],
					details: { error: message } satisfies ListMcpResourcesDetails,
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
					details: { error: message } satisfies ListMcpResourcesDetails,
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
					} satisfies ListMcpResourcesDetails,
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
					} satisfies ListMcpResourcesDetails,
				};
			}

			const lines: string[] = [];
			lines.push(`MCP config: ${configPath}`);
			lines.push(`Servers matched: ${targetServers.length}`);
			if (serverFilter) lines.push(`Server filter: ${serverFilter}`);

			let totalResources = 0;
			let serversFailed = 0;

			for (const target of targetServers) {
				lines.push("");
				lines.push(`## [${target.name}]`);
				try {
					const result = await listRemoteMcpResources({
						serverUrl: target.url,
						serverHeaders: target.headers,
						signal,
						toolCallId,
					});
					if (result.resources.length === 0) {
						lines.push("(no resources)");
						continue;
					}
					for (const resource of result.resources) {
						totalResources++;
						lines.push(`- uri: ${resource.uri}`);
						lines.push(`  name: ${resource.name}`);
						if (resource.mimeType) lines.push(`  mimeType: ${resource.mimeType}`);
						if (resource.description) {
							const descLines = resource.description.split("\n");
							for (const descLine of descLines) {
								lines.push(`  ${descLine}`);
							}
						}
					}
					if (result.nextCursor) {
						lines.push(`  (additional resources available, nextCursor: ${result.nextCursor})`);
					}
				} catch (error) {
					serversFailed++;
					lines.push(`Error listing resources: ${formatErrorMessage(error)}`);
				}
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					config_path: configPath,
					servers_matched: targetServers.length,
					servers_queried: targetServers.length,
					servers_failed: serversFailed,
					total_resources: totalResources,
				} satisfies ListMcpResourcesDetails,
			};
		},
	});
}
