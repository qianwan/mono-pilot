import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";

export interface SftpTargetConfig {
	name?: string;
	protocol?: string;
	host: string;
	port?: number;
	username: string;
	password?: string;
	privateKeyPath?: string;
	privateKey?: string;
	passphrase?: string;
	remotePath: string;
	uploadOnSave?: boolean;
	interactiveAuth?: boolean;
}

export interface SftpSyncDetails {
	targets: string[];
	uploaded: number;
	errors?: string[];
}

interface SftpClientInstance {
	on(eventType: string, listener: (...args: unknown[]) => void): void;
	connect(config: Record<string, unknown>): Promise<unknown>;
	exists(path: string): Promise<unknown>;
	put(source: string, destination: string): Promise<unknown>;
	fastGet(source: string, destination: string): Promise<unknown>;
	uploadDir(source: string, destination: string): Promise<unknown>;
	downloadDir(source: string, destination: string): Promise<unknown>;
	mkdir(path: string, recursive?: boolean): Promise<unknown>;
	end(): Promise<unknown>;
}

interface CachedSftpConnection {
	client: SftpClientInstance;
	ready: boolean;
	connecting?: Promise<void>;
}

const connectionCache = new Map<string, CachedSftpConnection>();


function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) {
		return resolve(homedir(), value.slice(2));
	}
	return value;
}

function normalizeTarget(raw: Record<string, unknown>): SftpTargetConfig | null {
	const protocol = readString(raw.protocol);
	if (protocol && protocol !== "sftp") return null;
	const host = readString(raw.host);
	const username = readString(raw.username);
	const remotePath = readString(raw.remotePath);
	if (!host || !username || !remotePath) {
		return null;
	}
	const privateKeyPath = readString(raw.privateKeyPath);
	return {
		name: readString(raw.name),
		protocol,
		host,
		port: readNumber(raw.port),
		username,
		password: readString(raw.password),
		privateKeyPath: privateKeyPath ? expandHome(privateKeyPath) : undefined,
		privateKey: readString(raw.privateKey),
		passphrase: readString(raw.passphrase),
		remotePath,
		uploadOnSave: readBoolean(raw.uploadOnSave),
		interactiveAuth: readBoolean(raw.interactiveAuth),
	};
}

function toPosixPath(value: string): string {
	return value.split(sep).join(posix.sep);
}

function resolveLocalPath(cwd: string, targetPath: string): string {
	return isAbsolute(targetPath) ? targetPath : resolve(cwd, targetPath);
}

function buildRemotePath(remoteRoot: string, localPath: string, cwd: string): string | null {
	const rel = relative(cwd, localPath);
	if (!rel || rel.startsWith("..") || rel.includes(".." + sep)) {
		return null;
	}
	return posix.join(remoteRoot, toPosixPath(rel));
}

function describeTarget(target: SftpTargetConfig): string {
	return target.name ? `${target.name} (${target.host})` : target.host;
}

function getTargetCacheKey(target: SftpTargetConfig): string {
	return target.name ?? target.host;
}

export function isSftpAuthFailure(errors?: string[]): boolean {
	if (!errors || errors.length === 0) return false;
	return errors.some((err) => {
		const text = err.toLowerCase();
		return text.includes("authentication methods failed") || text.includes("authentication failed");
	});
}

export function hasSftpConnection(target: SftpTargetConfig): boolean {
	const entry = connectionCache.get(getTargetCacheKey(target));
	return Boolean(entry?.ready);
}

function buildConnectConfig(target: SftpTargetConfig): Record<string, unknown> {
	const config: Record<string, unknown> = {
		host: target.host,
		port: target.port ?? 22,
		username: target.username,
	};
	if (target.password) {
		config.password = target.password;
	}
	if (target.privateKey) {
		config.privateKey = target.privateKey;
	}
	if (target.privateKeyPath) {
		config.privateKey = readFileSync(target.privateKeyPath);
	}
	if (target.passphrase) {
		config.passphrase = target.passphrase;
	}
	if (target.interactiveAuth) {
		config.tryKeyboard = true;
	}
	return config;
}

function attachOtpHandler(client: SftpClientInstance, otp: string): void {
	client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
		const answers = (Array.isArray(prompts) ? prompts : []).map(() => otp);
		if (typeof finish === "function") {
			finish(answers);
		}
	});
}

function registerConnectionLifecycle(key: string, client: SftpClientInstance): void {
	const drop = () => {
		connectionCache.delete(key);
	};
	client.on("close", drop);
	client.on("end", drop);
	client.on("error", drop);
}

async function createSftpClient(): Promise<SftpClientInstance> {
	const { default: SftpClient } = await import("ssh2-sftp-client");
	const ClientCtor = SftpClient as unknown as { new (): SftpClientInstance };
	return new ClientCtor();
}

async function getOrCreateConnection(options: {
	target: SftpTargetConfig;
	otp?: string;
	requireExisting?: boolean;
}): Promise<SftpClientInstance> {
	const key = getTargetCacheKey(options.target);
	const existing = connectionCache.get(key);
	if (options.requireExisting && !existing?.ready) {
		throw new Error("No active SFTP session");
	}
	if (existing?.ready) {
		return existing.client;
	}
	if (!existing) {
		const client = await createSftpClient();
		const entry: CachedSftpConnection = { client, ready: false };
		connectionCache.set(key, entry);
		registerConnectionLifecycle(key, client);
	}
	const entry = connectionCache.get(key);
	if (!entry) {
		throw new Error("Failed to initialize SFTP client");
	}
	if (!entry.connecting) {
		entry.connecting = (async () => {
			if (options.target.interactiveAuth) {
				if (options.otp) {
					attachOtpHandler(entry.client, options.otp);
				}
			}
			await entry.client.connect(buildConnectConfig(options.target));
			entry.ready = true;
		})().catch((error) => {
			connectionCache.delete(key);
			throw error;
		});
	}
	await entry.connecting;
	return entry.client;
}

export async function loadSftpTargets(cwd: string): Promise<SftpTargetConfig[]> {
	const configPath = resolve(cwd, ".vscode/sftp.json");
	if (!existsSync(configPath)) {
		return [];
	}
	const rawText = await readFile(configPath, "utf-8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawText);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid .vscode/sftp.json: ${message}`);
	}
	const entries = Array.isArray(parsed) ? parsed : isRecord(parsed) ? [parsed] : [];
	return entries
		.map((entry) => (isRecord(entry) ? normalizeTarget(entry) : null))
		.filter((entry): entry is SftpTargetConfig => Boolean(entry))
		.filter((entry) => entry.uploadOnSave !== false);
}

export async function syncSftpFile(options: {
	cwd: string;
	localPath: string;
	targets: SftpTargetConfig[];
	requireExisting?: boolean;
	otp?: string;
}): Promise<SftpSyncDetails> {
	const targets = options.targets;
	const labels = targets.map((target) => describeTarget(target));
	const errors: string[] = [];
	let uploaded = 0;

	const localAbsolute = resolve(options.localPath);
	if (!existsSync(localAbsolute)) {
		return {
			targets: labels,
			uploaded,
			errors: [`local file missing: ${localAbsolute}`],
		};
	}

	for (const target of targets) {
		const label = describeTarget(target);
		if (target.interactiveAuth) {
			if (options.requireExisting && !hasSftpConnection(target)) {
				errors.push(`${label}: no active SFTP session`);
				continue;
			}
		}
		const remotePath = buildRemotePath(target.remotePath, localAbsolute, options.cwd);
		if (!remotePath) {
			errors.push(`${label}: file outside workspace`);
			continue;
		}
		try {
			const client = await getOrCreateConnection({
				target,
				requireExisting: options.requireExisting,
				otp: options.otp,
			});
			await client.mkdir(posix.dirname(remotePath), true);
			await client.put(localAbsolute, remotePath);
			uploaded += 1;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push(`${label}: ${message}`);
		}
	}

	return {
		targets: labels,
		uploaded,
		errors: errors.length > 0 ? errors : undefined,
	};
}

export async function uploadSftpPath(options: {
	cwd: string;
	localPath: string;
	targets: SftpTargetConfig[];
	requireExisting?: boolean;
	otp?: string;
}): Promise<SftpSyncDetails> {
	const targets = options.targets;
	const labels = targets.map((target) => describeTarget(target));
	const errors: string[] = [];
	let uploaded = 0;

	const localAbsolute = resolveLocalPath(options.cwd, options.localPath);
	if (!existsSync(localAbsolute)) {
		return {
			targets: labels,
			uploaded,
			errors: [`local path missing: ${localAbsolute}`],
		};
	}
	const stats = statSync(localAbsolute);
	const isDirectory = stats.isDirectory();
	for (const target of targets) {
		const label = describeTarget(target);
		if (target.interactiveAuth) {
			if (options.requireExisting && !hasSftpConnection(target)) {
				errors.push(`${label}: no active SFTP session`);
				continue;
			}
		}
		const remotePath = buildRemotePath(target.remotePath, localAbsolute, options.cwd);
		if (!remotePath) {
			errors.push(`${label}: path outside workspace`);
			continue;
		}
		try {
			const client = await getOrCreateConnection({
				target,
				requireExisting: options.requireExisting,
				otp: options.otp,
			});
			if (isDirectory) {
				await client.uploadDir(localAbsolute, remotePath);
			} else {
				await client.mkdir(posix.dirname(remotePath), true);
				await client.put(localAbsolute, remotePath);
			}
			uploaded += 1;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push(`${label}: ${message}`);
		}
	}

	return {
		targets: labels,
		uploaded,
		errors: errors.length > 0 ? errors : undefined,
	};
}

export async function downloadSftpPath(options: {
	cwd: string;
	localPath: string;
	targets: SftpTargetConfig[];
	requireExisting?: boolean;
	otp?: string;
}): Promise<SftpSyncDetails> {
	const targets = options.targets;
	const labels = targets.map((target) => describeTarget(target));
	const errors: string[] = [];
	let downloaded = 0;

	const localAbsolute = resolveLocalPath(options.cwd, options.localPath);
	for (const target of targets) {
		const label = describeTarget(target);
		if (target.interactiveAuth) {
			if (options.requireExisting && !hasSftpConnection(target)) {
				errors.push(`${label}: no active SFTP session`);
				continue;
			}
		}
		const remotePath = buildRemotePath(target.remotePath, localAbsolute, options.cwd);
		if (!remotePath) {
			errors.push(`${label}: path outside workspace`);
			continue;
		}
		try {
			const client = await getOrCreateConnection({
				target,
				requireExisting: options.requireExisting,
				otp: options.otp,
			});
			const exists = await client.exists(remotePath);
			if (!exists) {
				errors.push(`${label}: remote path not found`);
				continue;
			}
			if (exists === "d") {
				await client.downloadDir(remotePath, localAbsolute);
			} else {
				await mkdir(dirname(localAbsolute), { recursive: true });
				await client.fastGet(remotePath, localAbsolute);
			}
			downloaded += 1;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push(`${label}: ${message}`);
		}
	}

	return {
		targets: labels,
		uploaded: downloaded,
		errors: errors.length > 0 ? errors : undefined,
	};
}