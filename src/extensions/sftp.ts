import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { publishSystemEvent } from "./system-events.js";

interface SftpTargetConfig {
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
	hop?: SftpHopConfig;
}

interface SftpHopConfig {
	host: string;
	port?: number;
	username: string;
	password?: string;
	privateKeyPath?: string;
	privateKey?: string;
	passphrase?: string;
	interactiveAuth?: boolean;
}

interface SftpSyncDetails {
	targets: string[];
	uploaded: number;
	errors?: string[];
}

interface ApplyPatchResultDetails {
	operation: "add" | "update";
	path: string;
	moveTo?: string;
	appliedHunks?: number;
}

interface CodexApplyPatchResultDetails {
	added: string[];
	modified: string[];
	deleted?: string[];
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
	cleanup?: () => void;
}

interface SshTunnelClient {
	on(eventType: string, listener: (...args: unknown[]) => void): void;
	once(eventType: string, listener: (...args: unknown[]) => void): void;
	removeListener(eventType: string, listener: (...args: unknown[]) => void): void;
	connect(config: Record<string, unknown>): void;
	forwardOut(
		srcIP: string,
		srcPort: number,
		dstIP: string,
		dstPort: number,
		cb: (err: Error | undefined, stream: unknown) => void,
	): void;
	end(): void;
}

type OtpProvider = () => Promise<string | null>;

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
	const hop = normalizeHop(raw.hop);
	if (hop === null) {
		return null;
	}
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
		hop,
	};
}

function normalizeHop(raw: unknown): SftpHopConfig | null | undefined {
	if (raw === undefined) {
		return undefined;
	}
	if (!isRecord(raw)) {
		return null;
	}

	const host = readString(raw.host);
	const username = readString(raw.username);
	if (!host || !username) {
		return null;
	}

	const privateKeyPath = readString(raw.privateKeyPath);
	return {
		host,
		port: readNumber(raw.port),
		username,
		password: readString(raw.password),
		privateKeyPath: privateKeyPath ? expandHome(privateKeyPath) : undefined,
		privateKey: readString(raw.privateKey),
		passphrase: readString(raw.passphrase),
		interactiveAuth: readBoolean(raw.interactiveAuth),
	};
}

function toPosixPath(value: string): string {
	return value.split(sep).join(posix.sep);
}

function resolveLocalPath(cwd: string, targetPath: string): string {
	return isAbsolute(targetPath) ? targetPath : resolve(cwd, targetPath);
}

function isPathWithinCwd(cwd: string, targetPath: string): boolean {
	const resolved = resolve(targetPath);
	const rel = relative(cwd, resolved);
	if (!rel) {
		return false;
	}
	return !rel.startsWith("..") && !rel.includes(".." + sep);
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
	const base = target.name ?? target.host;
	if (!target.hop) {
		return base;
	}
	return `${base} via ${target.hop.username}@${target.hop.host}:${target.hop.port ?? 22}`;
}

function targetRequiresInteractiveAuth(target: SftpTargetConfig): boolean {
	return target.interactiveAuth === true || target.hop?.interactiveAuth === true;
}

function shouldRetryInteractiveAuth(errors?: string[]): boolean {
	if (!errors || errors.length === 0) return false;
	return errors.some((err) => {
		const text = err.toLowerCase();
		return (
			text.includes("authentication methods failed") ||
			text.includes("authentication failed") ||
			text.includes("timed out while waiting for handshake")
		);
	});
}

function hasSftpConnection(target: SftpTargetConfig): boolean {
	const entry = connectionCache.get(getTargetCacheKey(target));
	return Boolean(entry?.ready);
}

function buildConnectConfig(target: {
	host: string;
	port?: number;
	username: string;
	password?: string;
	privateKeyPath?: string;
	privateKey?: string;
	passphrase?: string;
	interactiveAuth?: boolean;
}): Record<string, unknown> {
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

function registerConnectionLifecycle(key: string, entry: CachedSftpConnection): void {
	const drop = () => {
		if (entry.cleanup) {
			entry.cleanup();
			entry.cleanup = undefined;
		}
		const current = connectionCache.get(key);
		if (current === entry) {
			connectionCache.delete(key);
		}
	};
	entry.client.on("close", drop);
	entry.client.on("end", drop);
	entry.client.on("error", drop);
}

async function createSftpClient(): Promise<SftpClientInstance> {
	const { default: SftpClient } = await import("ssh2-sftp-client");
	const ClientCtor = SftpClient as unknown as {
		new (
			clientName?: string,
			callbacks?: Record<string, (...args: unknown[]) => void>,
		): SftpClientInstance;
	};
	return new ClientCtor("mono-pilot-sftp", {
		error: () => {
			// Operation-level errors are handled by promise rejections.
		},
		end: () => {
			// Suppress default global end log spam in interactive TUI.
		},
		close: () => {
			// Suppress default global close log spam in interactive TUI.
		},
	});
}

async function createSshTunnelClient(): Promise<SshTunnelClient> {
	const ssh2Module = (await import("ssh2")) as {
		Client: new () => SshTunnelClient;
	};
	return new ssh2Module.Client();
}

async function createForwardStreamViaHop(options: {
	hop: SftpHopConfig;
	targetHost: string;
	targetPort: number;
	attachKeyboardInteractive?: (client: { on(eventType: string, listener: (...args: unknown[]) => void): void }) => void;
}): Promise<{ client: SshTunnelClient; stream: unknown }> {
	const hopClient = await createSshTunnelClient();
	if (options.hop.interactiveAuth && options.attachKeyboardInteractive) {
		options.attachKeyboardInteractive(hopClient);
	}

	await new Promise<void>((resolveReady, rejectReady) => {
		const onReady = () => {
			hopClient.removeListener("error", onError);
			resolveReady();
		};
		const onError = (error: unknown) => {
			hopClient.removeListener("ready", onReady);
			rejectReady(error instanceof Error ? error : new Error(String(error)));
		};
		hopClient.once("ready", onReady);
		hopClient.once("error", onError);
		hopClient.connect(buildConnectConfig(options.hop));
	});

	const stream = await new Promise<unknown>((resolveStream, rejectStream) => {
		hopClient.forwardOut("127.0.0.1", 0, options.targetHost, options.targetPort, (err, forwarded) => {
			if (err) {
				rejectStream(err);
				return;
			}
			resolveStream(forwarded);
		});
	}).catch((error) => {
		try {
			hopClient.end();
		} catch {
			// Best effort cleanup.
		}
		throw error;
	});

	return { client: hopClient, stream };
}

async function getOrCreateConnection(options: {
	target: SftpTargetConfig;
	otp?: string | null;
	otpProvider?: OtpProvider;
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
		registerConnectionLifecycle(key, entry);
	}
	const entry = connectionCache.get(key);
	if (!entry) {
		throw new Error("Failed to initialize SFTP client");
	}
	if (!entry.connecting) {
		entry.connecting = (async () => {
			const shouldHandleOtp = targetRequiresInteractiveAuth(options.target) && (options.otp || options.otpProvider);
			let attachKeyboardInteractive:
				| ((client: { on(eventType: string, listener: (...args: unknown[]) => void): void }) => void)
				| undefined;

			if (shouldHandleOtp) {
				let resolvedOtp: string | null | undefined = options.otp ?? undefined;
				let otpPromise: Promise<string | null> | null = null;
				const resolveOtp = async () => {
					if (resolvedOtp !== undefined) {
						return resolvedOtp;
					}
					if (!options.otpProvider) {
						resolvedOtp = null;
						return resolvedOtp;
					}
					if (!otpPromise) {
						otpPromise = options.otpProvider();
					}
					resolvedOtp = await otpPromise;
					return resolvedOtp;
				};
				attachKeyboardInteractive = (client) => {
					client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
						void (async () => {
							const otp = await resolveOtp();
							const answers = (Array.isArray(prompts) ? prompts : []).map(() => otp ?? "");
							if (typeof finish === "function") {
								finish(answers);
							}
						})();
					});
				};
			}

			if (options.target.hop) {
				const tunnel = await createForwardStreamViaHop({
					hop: options.target.hop,
					targetHost: options.target.host,
					targetPort: options.target.port ?? 22,
					attachKeyboardInteractive,
				});
				entry.cleanup = () => {
					try {
						tunnel.client.end();
					} catch {
						// Best effort tunnel cleanup.
					}
				};
				if (options.target.interactiveAuth && attachKeyboardInteractive) {
					attachKeyboardInteractive(entry.client);
				}
				await entry.client.connect({
					...buildConnectConfig(options.target),
					sock: tunnel.stream,
				});
			} else {
				if (options.target.interactiveAuth && attachKeyboardInteractive) {
					attachKeyboardInteractive(entry.client);
				}
				await entry.client.connect(buildConnectConfig(options.target));
			}

			entry.ready = true;
		})().catch((error) => {
			if (entry.cleanup) {
				entry.cleanup();
				entry.cleanup = undefined;
			}
			connectionCache.delete(key);
			throw error;
		});
	}
	await entry.connecting;
	return entry.client;
}

async function loadSftpTargets(cwd: string): Promise<SftpTargetConfig[]> {
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

async function syncSftpFile(options: {
	cwd: string;
	localPath: string;
	targets: SftpTargetConfig[];
	requireExisting?: boolean;
	otp?: string | null;
	otpProvider?: OtpProvider;
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
		if (targetRequiresInteractiveAuth(target)) {
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
				otpProvider: options.otpProvider,
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

function isApplyPatchResultDetails(value: unknown): value is ApplyPatchResultDetails {
	if (!isRecord(value)) {
		return false;
	}

	const operation = value.operation;
	if (operation !== "add" && operation !== "update") {
		return false;
	}

	if (typeof value.path !== "string" || value.path.trim().length === 0) {
		return false;
	}

	if (value.moveTo !== undefined && typeof value.moveTo !== "string") {
		return false;
	}

	if (value.appliedHunks !== undefined && typeof value.appliedHunks !== "number") {
		return false;
	}

	return true;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isCodexApplyPatchResultDetails(value: unknown): value is CodexApplyPatchResultDetails {
	if (!isRecord(value)) {
		return false;
	}
	if (!isStringArray(value.added) || !isStringArray(value.modified)) {
		return false;
	}
	if (value.deleted !== undefined && !isStringArray(value.deleted)) {
		return false;
	}
	return true;
}

interface PreparedAutoSyncTarget {
	target: SftpTargetConfig;
	requireExisting: boolean;
	otpProvider?: OtpProvider;
}

function isSftpSyncDetails(value: unknown): value is SftpSyncDetails {
	if (!isRecord(value)) {
		return false;
	}
	return Array.isArray(value.targets) && typeof value.uploaded === "number";
}

async function prepareAutoSyncTarget(cwd: string, context?: ExtensionContext): Promise<PreparedAutoSyncTarget | SftpSyncDetails | undefined> {
	let targets: SftpTargetConfig[];
	try {
		targets = await loadSftpTargets(cwd);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			targets: [],
			uploaded: 0,
			errors: [message],
		};
	}

	if (targets.length === 0) {
		return undefined;
	}

	const preferredTarget = selectedTargetId ? pickTarget(targets, selectedTargetId) : undefined;
	if (selectedTargetId && !preferredTarget) {
		return {
			targets: targets.map((target) => describeTarget(target)),
			uploaded: 0,
			errors: [`selected target not found: ${selectedTargetId}`],
		};
	}

	const selectedTarget = preferredTarget ?? targets[targets.length - 1]!;
	const otpProvider: OtpProvider | undefined =
		targetRequiresInteractiveAuth(selectedTarget) && context?.hasUI
			? async () => {
				const labels = [selectedTarget.name ?? selectedTarget.host];
				return await promptForOtp(context, labels);
			}
			: undefined;

	return {
		target: selectedTarget,
		requireExisting: targetRequiresInteractiveAuth(selectedTarget) && !otpProvider,
		otpProvider,
	};
}

function shouldSyncForApplyPatch(details: ApplyPatchResultDetails): boolean {
	if (details.operation === "add") {
		return true;
	}
	if (details.moveTo) {
		return true;
	}
	return typeof details.appliedHunks === "number" && details.appliedHunks > 0;
}

async function maybeSyncApplyPatchResult(
	cwd: string,
	details: ApplyPatchResultDetails,
	context?: ExtensionContext,
): Promise<SftpSyncDetails | undefined> {
	if (!shouldSyncForApplyPatch(details)) {
		return undefined;
	}
	const localPath = details.moveTo ?? details.path;
	if (!isPathWithinCwd(cwd, localPath)) {
		return undefined;
	}

	const prepared = await prepareAutoSyncTarget(cwd, context);
	if (!prepared) {
		return undefined;
	}
	if (isSftpSyncDetails(prepared)) {
		return prepared;
	}

	return syncSftpFile({
		cwd,
		localPath,
		targets: [prepared.target],
		requireExisting: prepared.requireExisting,
		otpProvider: prepared.otpProvider,
	});
}

async function maybeSyncCodexApplyPatchResult(
	cwd: string,
	details: CodexApplyPatchResultDetails,
	context?: ExtensionContext,
): Promise<SftpSyncDetails | undefined> {
	const dedupedPaths = Array.from(new Set([...details.added, ...details.modified].map((entry) => entry.trim())))
		.filter((entry) => entry.length > 0)
		.filter((entry) => isPathWithinCwd(cwd, entry));

	if (dedupedPaths.length === 0) {
		return undefined;
	}

	const prepared = await prepareAutoSyncTarget(cwd, context);
	if (!prepared) {
		return undefined;
	}
	if (isSftpSyncDetails(prepared)) {
		return prepared;
	}

	let uploaded = 0;
	const errors: string[] = [];
	let targets: string[] = [];

	for (const localPath of dedupedPaths) {
		const result = await syncSftpFile({
			cwd,
			localPath,
			targets: [prepared.target],
			requireExisting: prepared.requireExisting,
			otpProvider: prepared.otpProvider,
		});

		uploaded += result.uploaded;
		targets = result.targets;
		if (result.errors && result.errors.length > 0) {
			errors.push(`${localPath}: ${result.errors.join("; ")}`);
		}
	}

	return {
		targets,
		uploaded,
		errors: errors.length > 0 ? errors : undefined,
	};
}

async function uploadSftpPath(options: {
	cwd: string;
	localPath: string;
	targets: SftpTargetConfig[];
	requireExisting?: boolean;
	otp?: string | null;
	otpProvider?: OtpProvider;
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
		if (targetRequiresInteractiveAuth(target)) {
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
				otpProvider: options.otpProvider,
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

async function downloadSftpPath(options: {
	cwd: string;
	localPath: string;
	targets: SftpTargetConfig[];
	requireExisting?: boolean;
	otp?: string | null;
	otpProvider?: OtpProvider;
}): Promise<SftpSyncDetails> {
	const targets = options.targets;
	const labels = targets.map((target) => describeTarget(target));
	const errors: string[] = [];
	let downloaded = 0;

	const localAbsolute = resolveLocalPath(options.cwd, options.localPath);
	for (const target of targets) {
		const label = describeTarget(target);
		if (targetRequiresInteractiveAuth(target)) {
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
				otpProvider: options.otpProvider,
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

type NotifyLevel = "info" | "warning" | "error";

const SFTP_USAGE = [
	"Usage:",
	"  /sftp",
	"  /sftp upload <path>",
	"  /sftp download <path>",
	"  /sftp target <targetName>",
].join("\n");

type SftpCommand = {
	cmd?: "upload" | "download" | "target" | "select";
	path?: string;
	name?: string;
};

let selectedTargetId: string | undefined;

function getTargetId(target: { name?: string; host: string }): string {
	return target.name ?? target.host;
}

function parseSubcommand(input: string): SftpCommand {
	const trimmed = input.trim();
	if (!trimmed) {
		return { cmd: "select" };
	}
	const lower = trimmed.toLowerCase();
	if (lower.startsWith("target ") || lower === "target") {
		const rawName = trimmed.slice("target".length).trim();
		return { cmd: "target", name: rawName || undefined };
	}
	const [commandRaw, ...rest] = trimmed.split(/\s+/);
	const command = commandRaw.toLowerCase();
	const path = rest.join(" ").trim();
	if (command !== "upload" && command !== "download") {
		return {};
	}
	return {
		cmd: command,
		path: path || undefined,
	};
}

function notify(
	ctx: ExtensionContext,
	message: string,
	level: NotifyLevel,
): void {
	if (level !== "info") {
		publishSystemEvent({
			source: "sftp",
			level,
			message,
			toast: false,
			ctx,
		});
	}

	if (ctx.hasUI && ctx.ui?.notify) {
		if (level === "info") {
			ctx.ui.notify(message, level);
		}
		return;
	}
	const prefix = level === "error" ? "[error]" : level === "warning" ? "[warn]" : "[info]";
	console.log(`${prefix} ${message}`);
}

function formatTargets(targets: string[]): string {
	return targets.length > 0 ? targets.join(", ") : "(none)";
}

function describeTargetName(name: string | undefined, host: string): string {
	return name ? `${name} (${host})` : host;
}

function renderTargetList(targets: Array<{ name?: string; host: string }>): string {
	if (targets.length === 0) return "(none)";
	return targets
		.map((target, index) => {
			const label = describeTargetName(target.name, target.host);
			const isSelected =
				(selectedTargetId && getTargetId(target) === selectedTargetId) ||
				(!selectedTargetId && index === targets.length - 1);
			return isSelected ? `* ${label}` : `  ${label}`;
		})
		.join("\n");
}

function pickTarget<T extends { name?: string; host: string }>(
	targets: T[],
	id: string | undefined,
): T | undefined {
	if (!id) return undefined;
	const named = targets.find((target) => target.name === id);
	if (named) {
		return named;
	}
	return targets.find((target) => getTargetId(target) === id);
}

async function promptForOtp(ctx: ExtensionContext, labels: string[]): Promise<string | null> {
	if (!ctx.hasUI) {
		return null;
	}
	const title = labels.length === 1 ? `SFTP OTP (${labels[0]})` : `SFTP OTP (${labels.length} targets)`;
	const value = await ctx.ui.input(title, "Enter one-time code");
	const normalized = value?.trim();
	return normalized && normalized.length > 0 ? normalized : null;
}

async function promptForTargetSelection(
	ctx: ExtensionContext,
	targets: SftpTargetConfig[],
): Promise<SftpTargetConfig | null> {
	if (!ctx.hasUI || !ctx.ui?.select) {
		return null;
	}

	const fallbackIndex = Math.max(0, targets.length - 1);
	const preferredIndexRaw = selectedTargetId
		? targets.findIndex((target) => getTargetId(target) === selectedTargetId)
		: fallbackIndex;
	const preferredIndex = preferredIndexRaw >= 0 ? preferredIndexRaw : fallbackIndex;

	const preferredTarget = targets[preferredIndex];
	const orderedTargets = preferredTarget
		? [preferredTarget, ...targets.filter((_, index) => index !== preferredIndex)]
		: [...targets];

	const options = orderedTargets.map((target, index) => {
		const label = describeTargetName(target.name, target.host);
		const currentTag = index === 0 ? " (current)" : "";
		return `[${index + 1}] ${label} -> ${target.remotePath}${currentTag}`;
	});

	const selectedOption = await ctx.ui.select("Select SFTP target", options);
	if (!selectedOption) {
		return null;
	}

	const selectedIndex = options.findIndex((option) => option === selectedOption);
	if (selectedIndex < 0 || selectedIndex >= orderedTargets.length) {
		return null;
	}

	return orderedTargets[selectedIndex] ?? null;
}

export function registerSftpCommands(pi: ExtensionAPI): void {
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) {
			return;
		}

		let sftp: SftpSyncDetails | undefined;
		if (event.toolName === "ApplyPatch" && isApplyPatchResultDetails(event.details)) {
			sftp = await maybeSyncApplyPatchResult(ctx.cwd, event.details, ctx);
		} else if (event.toolName === "CodexApplyPatch" && isCodexApplyPatchResultDetails(event.details)) {
			sftp = await maybeSyncCodexApplyPatchResult(ctx.cwd, event.details, ctx);
		}

		if (!sftp) {
			return;
		}
		const baseDetails = event.details as unknown as Record<string, unknown>;

		return {
			details: {
				...baseDetails,
				sftp,
			},
		};
	});

	pi.registerCommand("sftp", {
		description: "Sync files with SFTP (.vscode/sftp.json)",
		handler: async (args, ctx) => {
			const parsed = parseSubcommand(args);
			if (!parsed.cmd) {
				notify(ctx, SFTP_USAGE, "warning");
				return;
			}
			if ((parsed.cmd === "upload" || parsed.cmd === "download") && !parsed.path) {
				notify(ctx, SFTP_USAGE, "warning");
				return;
			}

			let targets: SftpTargetConfig[];
			try {
				targets = await loadSftpTargets(ctx.cwd);
			} catch (error) {
				notify(ctx, (error as Error).message, "error");
				return;
			}
			if (targets.length === 0) {
				notify(ctx, "No SFTP targets found in .vscode/sftp.json.", "warning");
				return;
			}

			if (parsed.cmd === "select") {
				if (!ctx.hasUI || !ctx.ui?.select) {
					notify(ctx, `Interactive target selection requires UI.\nAvailable targets:\n${renderTargetList(targets)}`, "warning");
					return;
				}

				const selected = await promptForTargetSelection(ctx, targets);
				if (!selected) {
					notify(ctx, "Target selection cancelled.", "warning");
					return;
				}

				selectedTargetId = getTargetId(selected);
				const label = describeTargetName(selected.name, selected.host);
				notify(ctx, `SFTP target set to ${label}.`, "info");
				return;
			}

			if (parsed.cmd === "target") {
				if (!parsed.name) {
					notify(ctx, `Missing target name.\n${SFTP_USAGE}`, "warning");
					return;
				}
				const selected = pickTarget(targets, parsed.name);
				if (!selected) {
					notify(ctx, `Unknown target: ${parsed.name}`, "warning");
					notify(ctx, `Available targets:\n${renderTargetList(targets)}`, "info");
					return;
				}
				selectedTargetId = getTargetId(selected);
				const label = describeTargetName(selected.name, selected.host);
				notify(ctx, `SFTP target set to ${label}.`, "info");
				return;
			}

			const explicit = selectedTargetId ? pickTarget(targets, selectedTargetId) : undefined;
			if (selectedTargetId && !explicit) {
				notify(ctx, `Selected target not found: ${selectedTargetId}`, "warning");
				notify(ctx, `Available targets:\n${renderTargetList(targets)}`, "info");
				return;
			}
			const selectedTargets = [explicit ?? targets[targets.length - 1]!];
			const targetPath = parsed.path;
			if (!targetPath) {
				notify(ctx, SFTP_USAGE, "warning");
				return;
			}

			const interactiveTargets = selectedTargets.filter((target) => targetRequiresInteractiveAuth(target));
			let otp: string | null | undefined = undefined;
			const otpProvider: OtpProvider | undefined =
				interactiveTargets.length > 0 && ctx.hasUI
					? async () => {
						if (otp !== undefined) {
							return otp;
						}
						const labels = interactiveTargets.map((target) => target.name ?? target.host);
						otp = await promptForOtp(ctx, labels);
						return otp;
					}
					: undefined;

			const action = parsed.cmd;
			const runAction = async (otpValue: string | null | undefined) => {
				return action === "upload"
					? await uploadSftpPath({
							cwd: ctx.cwd,
							localPath: targetPath,
							targets: selectedTargets,
							otp: otpValue ?? undefined,
							otpProvider,
							requireExisting: false,
						})
					: await downloadSftpPath({
							cwd: ctx.cwd,
							localPath: targetPath,
							targets: selectedTargets,
							otp: otpValue ?? undefined,
							otpProvider,
							requireExisting: false,
						});
			};

			let details = await runAction(otp);
			if (interactiveTargets.length > 0 && otp === undefined && shouldRetryInteractiveAuth(details.errors)) {
				if (!otpProvider) {
					notify(ctx, "OTP input requires interactive UI.", "warning");
					return;
				}
				otp = await otpProvider();
				if (!otp) {
					notify(ctx, "OTP input cancelled.", "warning");
					return;
				}
				details = await runAction(otp);
			}

			const countLabel = action === "upload" ? "uploaded" : "downloaded";
			const baseMessage = `${action} ${targetPath}: ${countLabel} ${details.uploaded} to ${formatTargets(
				details.targets,
			)}`;
			if (details.errors && details.errors.length > 0) {
				notify(ctx, `${baseMessage}\nerrors: ${details.errors.join("; ")}`, "warning");
				return;
			}
			notify(ctx, baseMessage, "info");
		},
	});
}
