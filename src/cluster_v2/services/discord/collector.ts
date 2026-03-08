import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import {
	extractDiscordCollectorConfig,
	type DiscordCollectorConfig,
	type DiscordSubscribeEvent,
} from "../../../config/discord.js";
import { loadMonoPilotConfigObject } from "../../../config/mono-pilot.js";
import { logClusterEvent, type ClusterLogContext } from "../../observability.js";
import type { ServiceDescriptor } from "../../rpc.js";
import {
	getAuthStorePath,
	readDiscordAuthToken,
	type DiscordAuthTokenRecord,
	writeDiscordAuthToken,
} from "./auth-store.js";
import { exchangeDiscordAuthorizeCode, tryRefreshDiscordToken } from "./oauth.js";
import { DiscordRpcClient } from "./rpc-client.js";

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const TOKEN_EXPIRY_SKEW_MS = 60_000;

function isTerminalAuthErrorMessage(message: string): boolean {
	return (
		message.includes("invalid_client") ||
		message.includes("access_denied") ||
		message.includes("invalid_grant")
	);
}

export interface DiscordCollectorHandle {
	descriptor: ServiceDescriptor;
	close(): Promise<void>;
}

interface PersistedDiscordEvent {
	seq: number;
	receivedAt: string;
	event: DiscordSubscribeEvent;
	channelId: string | null;
	channelAlias: string | null;
	channelName: string | null;
	guildId: string | null;
	guildName: string | null;
	messageId: string | null;
	authorId: string | null;
	authorUsername: string | null;
	content: string | null;
	attachments: string[];
	embeds: string[];
	raw?: unknown;
}

interface ChannelContext {
	channelName: string | null;
	guildId: string | null;
	guildName: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function readAttachmentUrls(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const urls: string[] = [];
	for (const item of value) {
		if (!isRecord(item)) {
			continue;
		}
		const url = readString(item.url) ?? readString(item.proxy_url);
		if (url) {
			urls.push(url);
		}
	}
	return urls;
}

function readEmbedUrls(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const urls: string[] = [];
	for (const item of value) {
		if (!isRecord(item)) {
			continue;
		}
		const candidates = [
			readString(item.url),
			isRecord(item.image) ? readString(item.image.url) : null,
			isRecord(item.thumbnail) ? readString(item.thumbnail.url) : null,
			isRecord(item.video) ? readString(item.video.url) : null,
		];
		for (const candidate of candidates) {
			if (candidate) {
				urls.push(candidate);
			}
		}
	}
	return urls;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTokenLikelyExpired(expiresAt: string | undefined): boolean {
	if (!expiresAt) {
		return false;
	}
	const expiresTime = Date.parse(expiresAt);
	if (!Number.isFinite(expiresTime)) {
		return false;
	}
	return expiresTime - Date.now() <= TOKEN_EXPIRY_SKEW_MS;
}

function formatLocalDateStamp(date: Date): string {
	const year = String(date.getFullYear());
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

class JsonlWriter {
	private queue: Promise<void> = Promise.resolve();
	private dirReady = false;
	private readonly outputDir: string;
	private readonly outputBaseName: string;
	private readonly outputExtension: string;
	private currentDateStamp: string | null = null;
	private currentOutputPath: string | null = null;

	constructor(
		private readonly outputPath: string,
		private readonly logContext: ClusterLogContext,
	) {
		const parsed = parse(outputPath);
		this.outputDir = parsed.dir;
		this.outputBaseName = parsed.name || parsed.base || "messages";
		this.outputExtension = parsed.ext || ".jsonl";
	}

	append(record: PersistedDiscordEvent): void {
		this.queue = this.queue
			.then(async () => {
				if (!this.dirReady) {
					await mkdir(this.outputDir || dirname(this.outputPath), { recursive: true });
					this.dirReady = true;
				}
				const currentPath = this.resolveCurrentOutputPath();
				await appendFile(currentPath, `${JSON.stringify(record)}\n`, "utf-8");
			})
			.catch((error) => {
				logClusterEvent("warn", "discord_collector_persist_failed", this.logContext, {
					error: error instanceof Error ? error.message : String(error),
					outputPath: this.outputPath,
					currentOutputPath: this.currentOutputPath,
				});
			});
	}

	private resolveCurrentOutputPath(now = new Date()): string {
		const dateStamp = formatLocalDateStamp(now);
		if (this.currentDateStamp === dateStamp && this.currentOutputPath) {
			return this.currentOutputPath;
		}

		this.currentDateStamp = dateStamp;
		this.currentOutputPath = join(
			this.outputDir,
			`${this.outputBaseName}.${dateStamp}${this.outputExtension}`,
		);
		return this.currentOutputPath;
	}

	async flush(): Promise<void> {
		await this.queue;
	}
}

class DiscordCollector implements DiscordCollectorHandle {
	private readonly writer: JsonlWriter;
	private readonly lifecycleContext: ClusterLogContext;
	private loop: Promise<void> | null = null;
	private closed = false;
	private client: DiscordRpcClient | null = null;
	private seq = 0;
	private reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
	private authToken: DiscordAuthTokenRecord | null = null;
	private warnedOauthConfig = false;
	private readonly channelContextCache = new Map<string, ChannelContext>();
	private readonly channelContextInFlight = new Map<string, Promise<ChannelContext>>();
	private readonly guildNameCache = new Map<string, string | null>();
	private readonly guildNameInFlight = new Map<string, Promise<string | null>>();
	private readonly channelAliasById = new Map<string, string>();

	descriptor: ServiceDescriptor = {
		name: "discord_intel",
		version: "v1",
		capabilities: {
			mode: "leader_local",
		},
	};

	constructor(private readonly config: DiscordCollectorConfig, context: ClusterLogContext) {
		this.lifecycleContext = {
			...context,
			role: context.role ? `${context.role}:discord_intel` : "discord_intel",
		};
		for (const channel of this.config.channels) {
			if (channel.alias) {
				this.channelAliasById.set(channel.id, channel.alias);
			}
		}
		this.writer = new JsonlWriter(this.config.outputPath, this.lifecycleContext);
		this.descriptor = {
			name: "discord_intel",
			version: "v1",
			capabilities: {
				mode: "leader_local",
				events: this.config.events,
				channelCount: this.config.channels.length,
				outputPath: this.config.outputPath,
			},
		};
	}

	start(): void {
		if (this.loop) {
			return;
		}
		this.loop = this.runLoop();
	}

	async close(): Promise<void> {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.client?.close();
		if (this.loop) {
			await this.loop;
		}
		await this.writer.flush();
		logClusterEvent("info", "discord_collector_stopped", this.lifecycleContext);
	}

	private async runLoop(): Promise<void> {
		logClusterEvent("info", "discord_collector_started", this.lifecycleContext, {
			outputPath: this.config.outputPath,
			events: this.config.events,
			channelCount: this.config.channels.length,
		});

		while (!this.closed) {
			try {
				await this.runOnce();
				this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
			} catch (error) {
				if (this.closed) {
					break;
				}
				const message = error instanceof Error ? error.message : String(error);
				if (isTerminalAuthErrorMessage(message)) {
					logClusterEvent("error", "discord_collector_terminal_auth_error", this.lifecycleContext, {
						error: message,
						action: "stop_retries_until_restart",
						authStorePath: getAuthStorePath(),
					});
					break;
				}
				logClusterEvent("warn", "discord_collector_cycle_failed", this.lifecycleContext, {
					error: message,
					retryInMs: this.reconnectDelayMs,
				});
				await sleep(this.reconnectDelayMs);
				this.reconnectDelayMs = Math.min(
					this.reconnectDelayMs * 2,
					this.config.maxReconnectDelayMs,
				);
			}
		}
	}

	private async runOnce(): Promise<void> {
		if (this.closed) {
			return;
		}

		const client = new DiscordRpcClient({
			clientId: this.config.clientId ?? "",
		});
		this.client = client;

		const unsubs = this.config.events.map((eventName) =>
			client.onEvent(eventName, (payload) => {
				void this.persistEvent(client, eventName, payload);
			}),
		);

		try {
			await client.connect();
			let accessToken = await this.resolveAccessToken(client);
			try {
				await client.authenticate(accessToken);
			} catch (error) {
				if (this.config.accessToken) {
					throw error;
				}

				logClusterEvent("warn", "discord_collector_auth_token_rejected", this.lifecycleContext, {
					error: error instanceof Error ? error.message : String(error),
				});

				const refreshed = await this.tryRefreshToken();
				if (refreshed) {
					accessToken = refreshed.accessToken;
					await client.authenticate(accessToken);
				} else {
					const interactive = await this.authorizeAndPersist(client);
					accessToken = interactive.accessToken;
					await client.authenticate(accessToken);
				}
			}

			for (const channel of this.config.channels) {
				for (const eventName of this.config.events) {
					await client.subscribe(eventName, { channel_id: channel.id });
				}
			}

			logClusterEvent("info", "discord_collector_connected", this.lifecycleContext, {
				channels: this.config.channels.length,
				events: this.config.events,
			});

			await client.waitForDisconnect();
			if (!this.closed) {
				throw new Error("discord ipc disconnected");
			}
		} finally {
			for (const unsub of unsubs) {
				unsub();
			}
			client.close();
			if (this.client === client) {
				this.client = null;
			}
		}
	}

	private async resolveAccessToken(client: DiscordRpcClient): Promise<string> {
		if (this.config.accessToken) {
			return this.config.accessToken;
		}

		await this.loadCachedAuthToken();

		if (this.authToken && isTokenLikelyExpired(this.authToken.expiresAt)) {
			const refreshed = await this.tryRefreshToken();
			if (refreshed) {
				return refreshed.accessToken;
			}
		}

		if (this.authToken?.accessToken) {
			return this.authToken.accessToken;
		}

		const interactive = await this.authorizeAndPersist(client);
		return interactive.accessToken;
	}

	private async loadCachedAuthToken(): Promise<void> {
		if (this.authToken || this.config.accessToken || !this.config.clientId) {
			return;
		}

		try {
			this.authToken = await readDiscordAuthToken(this.config.clientId);
			if (this.authToken) {
				logClusterEvent("info", "discord_collector_auth_cache_hit", this.lifecycleContext, {
					authStorePath: getAuthStorePath(),
				});
			} else {
				logClusterEvent("info", "discord_collector_auth_cache_miss", this.lifecycleContext, {
					authStorePath: getAuthStorePath(),
				});
			}
		} catch (error) {
			logClusterEvent("warn", "discord_collector_auth_cache_load_failed", this.lifecycleContext, {
				error: error instanceof Error ? error.message : String(error),
				authStorePath: getAuthStorePath(),
			});
		}
	}

	private async tryRefreshToken(): Promise<DiscordAuthTokenRecord | null> {
		if (!this.config.clientId || !this.authToken?.refreshToken) {
			return null;
		}

		const refreshed = await tryRefreshDiscordToken({
			clientId: this.config.clientId,
			clientSecret: this.config.clientSecret,
			redirectUri: this.config.redirectUri,
			scopes: this.config.scopes,
			refreshToken: this.authToken.refreshToken,
		});
		if (!refreshed) {
			return null;
		}

		const persisted = await this.persistAuthToken(refreshed);
		logClusterEvent("info", "discord_collector_auth_token_refreshed", this.lifecycleContext, {
			authStorePath: getAuthStorePath(),
		});
		return persisted;
	}

	private async authorizeAndPersist(client: DiscordRpcClient): Promise<DiscordAuthTokenRecord> {
		if (!this.config.clientId) {
			throw new Error("discord collector requires clientId");
		}

		if (!this.warnedOauthConfig && !this.config.clientSecret && !this.config.accessToken) {
			this.warnedOauthConfig = true;
			logClusterEvent("warn", "discord_collector_missing_client_secret", this.lifecycleContext, {
				hint:
					"oauth2/token authorization_code usually requires clientSecret (and sometimes redirectUri)",
			});
		}

		logClusterEvent("info", "discord_collector_authorize_start", this.lifecycleContext, {
			authStorePath: getAuthStorePath(),
			scopes: this.config.scopes,
		});

		const { code } = await client.authorize(this.config.scopes);
		const exchanged = await exchangeDiscordAuthorizeCode({
			clientId: this.config.clientId,
			clientSecret: this.config.clientSecret,
			redirectUri: this.config.redirectUri,
			scopes: this.config.scopes,
			code,
		});
		const persisted = await this.persistAuthToken(exchanged);

		logClusterEvent("info", "discord_collector_authorize_success", this.lifecycleContext, {
			authStorePath: getAuthStorePath(),
		});
		return persisted;
	}

	private async persistAuthToken(
		token: Omit<DiscordAuthTokenRecord, "updatedAt">,
	): Promise<DiscordAuthTokenRecord> {
		if (!this.config.clientId) {
			throw new Error("discord collector requires clientId");
		}

		try {
			const persisted = await writeDiscordAuthToken(this.config.clientId, token);
			this.authToken = persisted;
			return persisted;
		} catch (error) {
			logClusterEvent("warn", "discord_collector_auth_cache_write_failed", this.lifecycleContext, {
				error: error instanceof Error ? error.message : String(error),
				authStorePath: getAuthStorePath(),
			});
			const fallback: DiscordAuthTokenRecord = {
				...token,
				updatedAt: new Date().toISOString(),
			};
			this.authToken = fallback;
			return fallback;
		}
	}

	private async persistEvent(
		client: DiscordRpcClient,
		eventName: DiscordSubscribeEvent,
		payload: unknown,
	): Promise<void> {
		const payloadRecord = isRecord(payload) ? payload : null;
		const messageRecord =
			payloadRecord && isRecord(payloadRecord.message) ? payloadRecord.message : payloadRecord;
		const authorRecord = messageRecord && isRecord(messageRecord.author) ? messageRecord.author : null;
		const channelId =
			readString(payloadRecord?.channel_id) ?? readString(messageRecord?.channel_id) ?? null;
		const channelAlias = channelId ? (this.channelAliasById.get(channelId) ?? null) : null;
		let guildId = readString(payloadRecord?.guild_id) ?? readString(messageRecord?.guild_id) ?? null;
		let channelName: string | null = null;
		let guildName: string | null = null;

		if (channelId) {
			try {
				const context = await this.resolveChannelContext(client, channelId, guildId);
				channelName = context.channelName;
				guildId = guildId ?? context.guildId;
				guildName = context.guildName;
			} catch (error) {
				logClusterEvent("warn", "discord_collector_channel_context_failed", this.lifecycleContext, {
					channelId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		if (!guildName && guildId) {
			try {
				guildName = await this.resolveGuildName(client, guildId);
			} catch (error) {
				logClusterEvent("warn", "discord_collector_guild_context_failed", this.lifecycleContext, {
					guildId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		const record: PersistedDiscordEvent = {
			seq: ++this.seq,
			receivedAt: new Date().toISOString(),
			event: eventName,
			channelId,
			channelAlias,
			channelName,
			guildId,
			guildName,
			messageId: readString(messageRecord?.id),
			authorId: readString(authorRecord?.id),
			authorUsername: readString(authorRecord?.username),
			content: readString(messageRecord?.content),
			attachments: readAttachmentUrls(messageRecord?.attachments),
			embeds: readEmbedUrls(messageRecord?.embeds),
		};

		if (this.config.includeRawPayload) {
			record.raw = payload;
		}

		this.writer.append(record);
	}

	private async resolveChannelContext(
		client: DiscordRpcClient,
		channelId: string,
		fallbackGuildId: string | null,
	): Promise<ChannelContext> {
		const cached = this.channelContextCache.get(channelId);
		if (cached) {
			return cached;
		}

		const inFlight = this.channelContextInFlight.get(channelId);
		if (inFlight) {
			return inFlight;
		}

		const promise = (async () => {
			const channel = await client.getChannel(channelId);
			const guildId = channel.guildId ?? fallbackGuildId;
			const guildName = guildId ? await this.resolveGuildName(client, guildId) : null;
			const context: ChannelContext = {
				channelName: channel.name,
				guildId,
				guildName,
			};
			this.channelContextCache.set(channelId, context);
			return context;
		})()
			.finally(() => {
				this.channelContextInFlight.delete(channelId);
			});

		this.channelContextInFlight.set(channelId, promise);
		return promise;
	}

	private async resolveGuildName(client: DiscordRpcClient, guildId: string): Promise<string | null> {
		if (this.guildNameCache.has(guildId)) {
			return this.guildNameCache.get(guildId) ?? null;
		}

		const inFlight = this.guildNameInFlight.get(guildId);
		if (inFlight) {
			return inFlight;
		}

		const promise = (async () => {
			const guild = await client.getGuild(guildId);
			const name = guild.name;
			this.guildNameCache.set(guildId, name);
			return name;
		})()
			.catch((error) => {
				logClusterEvent("warn", "discord_collector_get_guild_failed", this.lifecycleContext, {
					guildId,
					error: error instanceof Error ? error.message : String(error),
				});
				this.guildNameCache.set(guildId, null);
				return null;
			})
			.finally(() => {
				this.guildNameInFlight.delete(guildId);
			});

		this.guildNameInFlight.set(guildId, promise);
		return promise;
	}
}

function validateCollectorConfig(
	config: DiscordCollectorConfig,
	context: ClusterLogContext,
): config is DiscordCollectorConfig & { clientId: string } {
	if (!config.enabled) {
		return false;
	}
	if (!config.clientId) {
		logClusterEvent("warn", "discord_collector_disabled_missing_client_id", context);
		return false;
	}
	if (config.channels.length === 0) {
		logClusterEvent("warn", "discord_collector_disabled_missing_channels", context);
		return false;
	}
	return true;
}

export async function maybeStartDiscordCollector(
	context: ClusterLogContext,
): Promise<DiscordCollectorHandle | null> {
	let configObject: Record<string, unknown>;
	try {
		configObject = await loadMonoPilotConfigObject();
	} catch (error) {
		logClusterEvent("warn", "discord_collector_config_load_failed", context, {
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}

	const config = extractDiscordCollectorConfig(configObject);
	if (!validateCollectorConfig(config, context)) {
		return null;
	}

	const collector = new DiscordCollector(config, context);
	collector.start();
	return collector;
}