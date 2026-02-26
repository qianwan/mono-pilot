import {
	extractStringHeaders,
	formatErrorMessage,
	getMcpConfigCandidates,
	inferTransport,
	isServerEnabled,
	loadMcpConfig,
	resolveMcpConfigSources,
	toNonEmptyString,
} from "./config.js";
import type { McpConfigSource, MergedMcpConfig } from "./config.js";

export type { McpConfigSource };

export interface TargetServer {
	name: string;
	url: string;
	headers: Record<string, string>;
}

/** Thrown when no MCP config files are found or config fails to parse. */
export class McpConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpConfigError";
	}
}

/** Thrown when a specific server can't be used (not found, disabled, wrong transport, etc.). */
export class McpServerError extends Error {
	constructor(
		message: string,
		public readonly transport: "remote" | "stdio" | "unknown" | undefined,
		public readonly configPaths: string[],
	) {
		super(message);
		this.name = "McpServerError";
	}
}

async function loadRequiredMcpConfig(cwd: string): Promise<MergedMcpConfig> {
	const sources = resolveMcpConfigSources(cwd);
	if (sources.length === 0) {
		const candidates = getMcpConfigCandidates(cwd);
		throw new McpConfigError(`MCP config not found. Checked:\n- ${candidates.join("\n- ")}`);
	}

	let config: MergedMcpConfig | undefined;
	try {
		config = await loadMcpConfig(cwd);
	} catch (error) {
		throw new McpConfigError(formatErrorMessage(error));
	}

	if (!config) {
		const candidates = getMcpConfigCandidates(cwd);
		throw new McpConfigError(`MCP config not found. Checked:\n- ${candidates.join("\n- ")}`);
	}

	return config;
}

/**
 * For list-style tools (ListMcpTools, ListMcpResources).
 * Returns all enabled remote servers matching the optional name filter.
 * Throws McpConfigError on config load failure.
 */
export async function resolveTargetServers(
	cwd: string,
	serverFilter?: string,
): Promise<{ servers: TargetServer[]; sources: McpConfigSource[]; configPaths: string[] }> {
	const config = await loadRequiredMcpConfig(cwd);
	const configPaths = config.sources.map((source) => source.path);
	const servers: TargetServer[] = [];

	for (const [serverName, serverConfig] of Object.entries(config.servers)) {
		if (serverFilter && serverName !== serverFilter) continue;
		if (!isServerEnabled(serverConfig)) continue;
		if (inferTransport(serverConfig) !== "remote") continue;
		const serverUrl = toNonEmptyString(serverConfig.url);
		if (!serverUrl) continue;
		servers.push({ name: serverName, url: serverUrl, headers: extractStringHeaders(serverConfig.headers) });
	}

	return { servers, sources: config.sources, configPaths };
}

/**
 * For single-server tools (CallMcpTool, FetchMcpResource).
 * Returns the resolved remote server or throws McpConfigError / McpServerError.
 */
export async function resolveTargetServer(
	cwd: string,
	serverName: string,
): Promise<{ server: TargetServer; configPaths: string[] }> {
	const config = await loadRequiredMcpConfig(cwd);
	const configPaths = config.sources.map((source) => source.path);

	const serverConfig = config.servers[serverName];
	if (!serverConfig) {
		throw new McpServerError(
			`MCP server '${serverName}' not found in configured MCP sources.`,
			undefined,
			configPaths,
		);
	}

	if (!isServerEnabled(serverConfig)) {
		throw new McpServerError(
			`MCP server '${serverName}' is disabled in config.`,
			inferTransport(serverConfig),
			configPaths,
		);
	}

	const transport = inferTransport(serverConfig);
	if (transport === "stdio") {
		const command = toNonEmptyString(serverConfig.command);
		const message = `MCP stdio transport is not supported yet.` + (command ? ` Configured command: ${command}` : "");
		throw new McpServerError(message, transport, configPaths);
	}

	const serverUrl = toNonEmptyString(serverConfig.url);
	if (!serverUrl) {
		throw new McpServerError(`MCP server '${serverName}' is missing a remote URL.`, transport, configPaths);
	}

	return {
		server: { name: serverName, url: serverUrl, headers: extractStringHeaders(serverConfig.headers) },
		configPaths,
	};
}
