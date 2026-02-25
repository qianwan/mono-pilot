import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
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

const DESCRIPTION = `Reads a specific resource from an MCP server, identified by server name and resource URI. Optionally, set downloadPath (relative to the workspace) to save the resource to disk; when set, the resource will be downloaded and not returned to the model.`;

const fetchMcpResourceSchema = Type.Object({
	server: Type.String({ description: "The MCP server identifier" }),
	uri: Type.String({ description: "The resource URI to read" }),
	downloadPath: Type.Optional(
		Type.String({
			description:
				"Optional relative path in the workspace to save the resource to. When set, the resource is written to disk and is not returned to the model.",
		}),
	),
});

type FetchMcpResourceInput = Static<typeof fetchMcpResourceSchema>;

interface FetchMcpResourceDetails {
	config_path?: string;
	server: string;
	uri: string;
	transport?: "remote" | "stdio" | "unknown";
	server_url?: string;
	error?: string;
	contents_count?: number;
	downloaded_to?: string;
}

interface McpResourceContent {
	uri: string;
	mimeType?: string;
	text?: string;
	blob?: string;
}

async function fetchRemoteMcpResource(options: {
	serverUrl: string;
	serverHeaders: Record<string, string>;
	uri: string;
	signal: AbortSignal | undefined;
	toolCallId: string;
}): Promise<McpResourceContent[]> {
	let sessionId = await initializeMcpSession(options);

	const readResponse = await postJsonRpcRequest({
		url: options.serverUrl,
		headers: options.serverHeaders,
		body: {
			jsonrpc: "2.0",
			id: createRpcRequestId(`${options.toolCallId}:resources.read`),
			method: "resources/read",
			params: {
				uri: options.uri,
			},
		},
		parentSignal: options.signal,
		sessionId,
		expectResponseBody: true,
	});

	const readBody = readResponse.parsedBody;
	if (readBody?.error) {
		throw new Error(formatJsonRpcError(readBody.error, "MCP resources/read failed."));
	}
	if (!readBody || !isRecord(readBody.result)) {
		throw new Error("MCP resources/read returned invalid result.");
	}

	const rawContents = readBody.result.contents;
	if (!Array.isArray(rawContents)) {
		throw new Error("MCP resources/read result.contents is not an array.");
	}

	const contents: McpResourceContent[] = [];
	for (const raw of rawContents) {
		if (!isRecord(raw)) continue;
		const contentUri = toNonEmptyString(raw.uri);
		if (!contentUri) continue;

		contents.push({
			uri: contentUri,
			mimeType: toNonEmptyString(raw.mimeType),
			text: typeof raw.text === "string" ? raw.text : undefined,
			blob: typeof raw.blob === "string" ? raw.blob : undefined,
		});
	}

	return contents;
}

function normalizeServerName(value: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error("server is required.");
	return normalized;
}

function normalizeUri(value: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error("uri is required.");
	return normalized;
}

function normalizeDownloadPath(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	if (!normalized) return undefined;
	if (isAbsolute(normalized)) {
		throw new Error("downloadPath must be a relative path.");
	}
	return normalized;
}

export default function fetchMcpResourceExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "FetchMcpResource",
		label: "FetchMcpResource",
		description: DESCRIPTION,
		parameters: fetchMcpResourceSchema,
		async execute(toolCallId, params: FetchMcpResourceInput, signal, _onUpdate, ctx) {
			let serverName: string;
			let uri: string;
			let downloadPath: string | undefined;

			try {
				serverName = normalizeServerName(params.server);
				uri = normalizeUri(params.uri);
				downloadPath = normalizeDownloadPath(params.downloadPath);
			} catch (error) {
				const message = formatErrorMessage(error);
				return {
					content: [{ type: "text", text: message }],
					details: {
						server: params.server,
						uri: params.uri,
						error: message,
					} satisfies FetchMcpResourceDetails,
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
					details: {
						server: serverName,
						uri,
						error: message,
					} satisfies FetchMcpResourceDetails,
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
						server: serverName,
						uri,
						error: message,
					} satisfies FetchMcpResourceDetails,
					isError: true,
				};
			}

			const serverConfig = servers[serverName];
			if (!serverConfig) {
				const message = `MCP server '${serverName}' not found in ${configPath}.`;
				return {
					content: [{ type: "text", text: message }],
					details: {
						config_path: configPath,
						server: serverName,
						uri,
						error: message,
					} satisfies FetchMcpResourceDetails,
					isError: true,
				};
			}

			if (!isServerEnabled(serverConfig)) {
				const message = `MCP server '${serverName}' is disabled in config.`;
				return {
					content: [{ type: "text", text: message }],
					details: {
						config_path: configPath,
						server: serverName,
						uri,
						transport: inferTransport(serverConfig),
						error: message,
					} satisfies FetchMcpResourceDetails,
					isError: true,
				};
			}

			const transport = inferTransport(serverConfig);
			if (transport === "stdio") {
				const command = toNonEmptyString(serverConfig.command);
				const message =
					`MCP stdio transport is not supported yet in FetchMcpResource.` +
					(command ? ` Configured command: ${command}` : "");
				return {
					content: [{ type: "text", text: message }],
					details: {
						config_path: configPath,
						server: serverName,
						uri,
						transport,
						error: message,
					} satisfies FetchMcpResourceDetails,
					isError: true,
				};
			}

			const serverUrl = toNonEmptyString(serverConfig.url);
			if (!serverUrl) {
				const message = `MCP server '${serverName}' is missing a remote URL.`;
				return {
					content: [{ type: "text", text: message }],
					details: {
						config_path: configPath,
						server: serverName,
						uri,
						transport,
						error: message,
					} satisfies FetchMcpResourceDetails,
					isError: true,
				};
			}

			const headers = extractStringHeaders(serverConfig.headers);

			try {
				const contents = await fetchRemoteMcpResource({
					serverUrl,
					serverHeaders: headers,
					uri,
					signal,
					toolCallId,
				});

				if (contents.length === 0) {
					return {
						content: [{ type: "text", text: `Resource '${uri}' returned no content.` }],
						details: {
							config_path: configPath,
							server: serverName,
							uri,
							transport,
							server_url: serverUrl,
							contents_count: 0,
						} satisfies FetchMcpResourceDetails,
					};
				}

				if (downloadPath) {
					// We only support downloading the first content item currently
					const contentToDownload = contents[0];
					const absoluteTarget = resolve(ctx.cwd, downloadPath);
					const { mkdir, writeFile } = await import("node:fs/promises");
					await mkdir(dirname(absoluteTarget), { recursive: true });

					let bytesWritten = 0;
					if (contentToDownload.blob !== undefined) {
						const buffer = Buffer.from(contentToDownload.blob, "base64");
						await writeFile(absoluteTarget, buffer);
						bytesWritten = buffer.length;
					} else if (contentToDownload.text !== undefined) {
						await writeFile(absoluteTarget, contentToDownload.text, "utf-8");
						bytesWritten = Buffer.byteLength(contentToDownload.text, "utf-8");
					} else {
						throw new Error("Resource content has neither text nor blob data.");
					}

					return {
						content: [
							{
								type: "text",
								text: `Successfully downloaded resource '${uri}' to '${downloadPath}' (${bytesWritten} bytes).`,
							},
						],
						details: {
							config_path: configPath,
							server: serverName,
							uri,
							transport,
							server_url: serverUrl,
							contents_count: contents.length,
							downloaded_to: downloadPath,
						} satisfies FetchMcpResourceDetails,
					};
				}

				// Return contents directly
				const lines: string[] = [];
				for (let i = 0; i < contents.length; i++) {
					const item = contents[i];
					lines.push(`## Content ${i + 1} (${item.uri})`);
					if (item.mimeType) lines.push(`mimeType: ${item.mimeType}`);

					if (item.text !== undefined) {
						lines.push("");
						lines.push(item.text);
					} else if (item.blob !== undefined) {
						lines.push("");
						lines.push(`[Binary blob data: ${item.blob.length} chars (base64)]`);
					} else {
						lines.push("");
						lines.push("[Empty content]");
					}
					lines.push("");
				}

				return {
					content: [{ type: "text", text: lines.join("\n").trim() }],
					details: {
						config_path: configPath,
						server: serverName,
						uri,
						transport,
						server_url: serverUrl,
						contents_count: contents.length,
					} satisfies FetchMcpResourceDetails,
				};
			} catch (error) {
				const message = formatErrorMessage(error);
				return {
					content: [{ type: "text", text: `FetchMcpResource failed: ${message}` }],
					details: {
						config_path: configPath,
						server: serverName,
						uri,
						transport,
						server_url: serverUrl,
						error: message,
					} satisfies FetchMcpResourceDetails,
					isError: true,
				};
			}
		},
	});
}
