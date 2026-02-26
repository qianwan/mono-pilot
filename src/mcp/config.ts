import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const MCP_CONFIG_RELATIVE_PATH = join(".pi", "mcp.json");

export type McpConfigScope = "project" | "user";

export interface McpConfigSource {
	scope: McpConfigScope;
	path: string;
}

export interface MergedMcpConfig {
	servers: Record<string, RawMcpServerConfig>;
	sources: McpConfigSource[];
	sourceByServer: Record<string, McpConfigSource>;
}

export interface RawMcpServerConfig {
	url?: unknown;
	command?: unknown;
	args?: unknown;
	headers?: unknown;
	env?: unknown;
	enabled?: unknown;
	disabled?: unknown;
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

export function getMcpConfigCandidates(workspaceCwd: string): string[] {
	return [resolve(workspaceCwd, MCP_CONFIG_RELATIVE_PATH), resolve(homedir(), MCP_CONFIG_RELATIVE_PATH)];
}

export function resolveMcpConfigSources(workspaceCwd: string): McpConfigSource[] {
	const projectPath = resolve(workspaceCwd, MCP_CONFIG_RELATIVE_PATH);
	const userPath = resolve(homedir(), MCP_CONFIG_RELATIVE_PATH);
	const sources: McpConfigSource[] = [];

	if (existsSync(projectPath)) sources.push({ scope: "project", path: projectPath });
	if (existsSync(userPath)) sources.push({ scope: "user", path: userPath });

	return sources;
}

export async function loadMcpConfig(workspaceCwd: string): Promise<MergedMcpConfig | undefined> {
	const sources = resolveMcpConfigSources(workspaceCwd);
	if (sources.length === 0) return undefined;

	const servers: Record<string, RawMcpServerConfig> = {};
	const sourceByServer: Record<string, McpConfigSource> = {};

	for (const source of sources) {
		const parsed = await parseMcpConfig(source.path);
		for (const [serverName, serverConfig] of Object.entries(parsed)) {
			if (sourceByServer[serverName]) continue;
			servers[serverName] = serverConfig;
			sourceByServer[serverName] = source;
		}
	}

	return { servers, sources, sourceByServer };
}

async function parseMcpConfig(configPath: string): Promise<Record<string, RawMcpServerConfig>> {
	const rawText = await readFile(configPath, "utf-8");
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
