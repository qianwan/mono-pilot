import { keyHint, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { resolveTargetServers, type TargetServer, type McpConfigSource } from "../src/mcp/servers.js";
import { createRpcRequestId, formatJsonRpcError, initializeMcpSession, postJsonRpcRequest } from "../src/mcp/protocol.js";
import { formatErrorMessage, isRecord, toNonEmptyString } from "../src/mcp/config.js";

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
	config_paths?: string[];
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

	return { resources, nextCursor: toNonEmptyString(resourcesBody.result.nextCursor) };
}

function normalizeOptionalString(value: string | undefined): string | undefined {
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
		renderCall(args, theme) {
			const input = args as Partial<ListMcpResourcesInput>;
			const server = typeof input.server === "string" && input.server.trim().length > 0 ? input.server : undefined;
			let text = theme.fg("toolTitle", theme.bold("ListMcpResources"));
			if (server) text += ` ${theme.fg("toolOutput", server)}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("muted", "Listing resources..."), 0, 0);
			}
			const textBlock = result.content.find(
				(entry): entry is { type: "text"; text: string } => entry.type === "text" && typeof entry.text === "string",
			);
			if (!textBlock) {
				return new Text(theme.fg("error", "No text result returned."), 0, 0);
			}
			const fullText = textBlock.text;
			const details = result.details as ListMcpResourcesDetails | undefined;
			const count = details?.total_resources ?? 0;
			if (!expanded) {
				const summary = `${count} resources (click or ${keyHint("expandTools", "to expand")})`;
				return new Text(theme.fg("muted", summary), 0, 0);
			}
			let text = fullText.split("\n").map((line: string) => theme.fg("toolOutput", line)).join("\n");
			text += theme.fg("muted", `\n(click or ${keyHint("expandTools", "to collapse")})`);
			return new Text(text, 0, 0);
		},
		async execute(toolCallId, params: ListMcpResourcesInput, signal, _onUpdate, ctx) {
			const serverFilter = normalizeOptionalString(params.server);

			let targetServers: TargetServer[];
			let sources: McpConfigSource[];

			try {
				const result = await resolveTargetServers(ctx.cwd, serverFilter);
				targetServers = result.servers;
				sources = result.sources;
			} catch (error) {
				const message = formatErrorMessage(error);
				return {
					content: [{ type: "text", text: message }],
					details: { error: message } satisfies ListMcpResourcesDetails,
					isError: true,
				};
			}

			if (targetServers.length === 0) {
				const message = serverFilter
					? `No active remote MCP server found matching '${serverFilter}'.`
					: "No active remote MCP servers found in config.";
				return {
					content: [{ type: "text", text: message }],
					details: {
						config_paths: sources.map((s) => s.path),
						servers_matched: 0,
					} satisfies ListMcpResourcesDetails,
				};
			}

			const lines: string[] = [];
			lines.push("MCP config:");
			for (const source of sources) {
				lines.push(`- ${source.scope}: ${source.path}`);
			}
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
							for (const descLine of resource.description.split("\n")) {
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
					config_paths: sources.map((s) => s.path),
					servers_matched: targetServers.length,
					servers_queried: targetServers.length,
					servers_failed: serversFailed,
					total_resources: totalResources,
				} satisfies ListMcpResourcesDetails,
			};
		},
	});
}
