import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { extractTwitterCollectorConfig, type TwitterCollectorConfig } from "../../../config/twitter.js";
import { loadMonoPilotConfigObject } from "../../../config/mono-pilot.js";
import {
	emitClusterV2TwitterCollectorStartupFailed,
	emitClusterV2TwitterPullBatch,
	emitClusterV2TwitterPullFailed,
} from "../../events.js";
import { logClusterEvent, type ClusterLogContext } from "../../observability.js";
import type { ServiceDescriptor } from "../../rpc.js";

interface BirdCommandResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

type PersistedTwitterTweet = Record<string, unknown>;

interface PersistedTwitterBatch {
	seq: number;
	fetchedAt: string;
	snapshotId: string;
	feed: "for_you";
	requestedCount: number;
	receivedCount: number;
	tweets: PersistedTwitterTweet[];
	raw?: unknown;
}

export interface TwitterCollectorHandle {
	descriptor: ServiceDescriptor;
	close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function readNestedString(record: Record<string, unknown>, path: string[]): string | null {
	let current: unknown = record;
	for (const key of path) {
		if (!isRecord(current) || !(key in current)) {
			return null;
		}
		current = current[key];
	}
	return readString(current);
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
		this.outputBaseName = parsed.name || parsed.base || "home";
		this.outputExtension = parsed.ext || ".jsonl";
	}

	append(record: PersistedTwitterBatch): void {
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
				logClusterEvent("warn", "twitter_collector_persist_failed", this.logContext, {
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

function buildBirdGlobalArgs(config: TwitterCollectorConfig): string[] {
	const args: string[] = [];
	if (config.chromeProfile) {
		args.push("--chrome-profile", config.chromeProfile);
	}
	if (config.chromeProfileDir) {
		args.push("--chrome-profile-dir", config.chromeProfileDir);
	}
	if (config.firefoxProfile) {
		args.push("--firefox-profile", config.firefoxProfile);
	}
	for (const source of config.cookieSource) {
		args.push("--cookie-source", source);
	}
	if (config.cookieTimeoutMs) {
		args.push("--cookie-timeout", String(config.cookieTimeoutMs));
	}
	if (config.requestTimeoutMs) {
		args.push("--timeout", String(config.requestTimeoutMs));
	}
	return args;
}

function runBirdCommand(args: string[], timeoutMs: number): Promise<BirdCommandResult> {
	return new Promise((resolve, reject) => {
		const child = spawn("bird", args, {
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		timer.unref();

		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});

		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});

		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});

		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolve({
				code,
				signal,
				stdout,
				stderr,
				timedOut,
			});
		});
	});
}

function formatBirdFailure(prefix: string, result: BirdCommandResult): string {
	const stderr = result.stderr.trim();
	const stdout = result.stdout.trim();
	const detail = stderr || stdout || `exit=${result.code ?? "null"} signal=${result.signal ?? "none"}`;
	if (result.timedOut) {
		return `${prefix}: timed out (${detail})`;
	}
	return `${prefix}: ${detail}`;
}

function looksLikeTweetRecord(record: Record<string, unknown>): boolean {
	const tweetId = extractTweetId(record);
	const text =
		readString(record.text) ??
		readString(record.full_text) ??
		readNestedString(record, ["legacy", "full_text"]) ??
		readNestedString(record, ["legacy", "text"]);
	return Boolean(tweetId || text);
}

function extractTweetId(record: Record<string, unknown>): string | null {
	return (
		readString(record.id) ??
		readString(record.id_str) ??
		readString(record.rest_id) ??
		readNestedString(record, ["legacy", "id_str"])
	);
}

function isLongFormTweet(record: Record<string, unknown>): boolean {
	return Boolean(
		isRecord(record.article) ||
		isRecord(record.note_tweet) ||
		isRecord(record.note_tweet_results),
	);
}

function parseTweetsFromPayload(payload: unknown, limit: number): PersistedTwitterTweet[] {
	const selected: PersistedTwitterTweet[] = [];
	const seen = new Set<string>();

	const appendFromArray = (items: unknown[]) => {
		for (const item of items) {
			if (!isRecord(item) || !looksLikeTweetRecord(item)) {
				continue;
			}
			const dedupeKey = extractTweetId(item) ?? "";
			if (dedupeKey && seen.has(dedupeKey)) {
				continue;
			}
			if (dedupeKey) {
				seen.add(dedupeKey);
			}
			selected.push({ ...item });
			if (selected.length >= limit) {
				return;
			}
		}
	};

	if (Array.isArray(payload)) {
		appendFromArray(payload);
		return selected;
	}

	if (!isRecord(payload)) {
		return selected;
	}

	const timelineArrayCandidates: unknown[][] = [];
	const directTweets = payload.tweets;
	if (Array.isArray(directTweets)) {
		timelineArrayCandidates.push(directTweets);
	}
	const directData = payload.data;
	if (Array.isArray(directData)) {
		timelineArrayCandidates.push(directData);
	}

	for (const candidate of timelineArrayCandidates) {
		appendFromArray(candidate);
		if (selected.length >= limit) {
			break;
		}
	}

	return selected;
}

class TwitterCollector implements TwitterCollectorHandle {
	private readonly writer: JsonlWriter;
	private readonly lifecycleContext: ClusterLogContext;
	private readonly birdGlobalArgs: string[];
	private intervalTimer: NodeJS.Timeout | null = null;
	private seq = 0;
	private inFlight = false;
	private closed = false;
	private readonly quotedTweetCache = new Map<string, Record<string, unknown>>();

	descriptor: ServiceDescriptor;

	constructor(private readonly config: TwitterCollectorConfig, context: ClusterLogContext) {
		this.lifecycleContext = {
			...context,
			role: context.role ? `${context.role}:twitter_intel` : "twitter_intel",
		};
		this.writer = new JsonlWriter(config.outputPath, this.lifecycleContext);
		this.birdGlobalArgs = buildBirdGlobalArgs(config);
		this.descriptor = {
			name: "twitter_intel",
			version: "v1",
			capabilities: {
				mode: "leader_local",
				feed: "for_you",
				pullCount: this.config.pullCount,
				pullIntervalMinutes: this.config.pullIntervalMinutes,
				outputPath: this.config.outputPath,
			},
		};
	}

	async start(): Promise<void> {
		await this.ensureBirdProfileReady();
		if (this.closed) {
			return;
		}
		logClusterEvent("info", "twitter_collector_started", this.lifecycleContext, {
			outputPath: this.config.outputPath,
			pullCount: this.config.pullCount,
			pullIntervalMinutes: this.config.pullIntervalMinutes,
		});

		void this.pullAndPersist("startup");
		const intervalMs = Math.max(1, Math.floor(this.config.pullIntervalMinutes * 60_000));
		this.intervalTimer = setInterval(() => {
			void this.pullAndPersist("interval");
		}, intervalMs);
		this.intervalTimer.unref();
	}

	async close(): Promise<void> {
		if (this.closed) {
			return;
		}
		this.closed = true;
		if (this.intervalTimer) {
			clearInterval(this.intervalTimer);
			this.intervalTimer = null;
		}
		await this.writer.flush();
		logClusterEvent("info", "twitter_collector_stopped", this.lifecycleContext);
	}

	private async ensureBirdProfileReady(): Promise<void> {
		const args = [...this.birdGlobalArgs, "check", "--plain"];
		let result: BirdCommandResult;
		try {
			result = await runBirdCommand(args, this.config.commandTimeoutMs);
		} catch (error) {
			throw new Error(`failed to start bird check: ${error instanceof Error ? error.message : String(error)}`);
		}

		if (result.code !== 0) {
			throw new Error(formatBirdFailure("bird profile check failed", result));
		}

		logClusterEvent("info", "twitter_collector_profile_check_ok", this.lifecycleContext);
	}

	private async pullAndPersist(trigger: "startup" | "interval"): Promise<void> {
		if (this.closed || this.inFlight) {
			return;
		}
		this.inFlight = true;
		const startedAt = Date.now();

		try {
			const payload = await this.fetchForYouTimeline();
			const tweets = parseTweetsFromPayload(payload, this.config.pullCount);
			await this.enrichQuotedLongFormTweets(tweets);
			const fetchedAt = new Date().toISOString();
			const seq = ++this.seq;
			const record: PersistedTwitterBatch = {
				seq,
				fetchedAt,
				snapshotId: `${fetchedAt}-${seq}`,
				feed: "for_you",
				requestedCount: this.config.pullCount,
				receivedCount: tweets.length,
				tweets,
			};
			if (this.config.includeRawPayload) {
				record.raw = payload;
			}
			this.writer.append(record);

			emitClusterV2TwitterPullBatch({
				scope: this.lifecycleContext.scope ?? "default",
				count: record.receivedCount,
				requestedCount: record.requestedCount,
				sequence: record.seq,
			});

			logClusterEvent("info", "twitter_collector_pull_success", this.lifecycleContext, {
				trigger,
				requestedCount: this.config.pullCount,
				receivedCount: tweets.length,
				durationMs: Date.now() - startedAt,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			emitClusterV2TwitterPullFailed({
				scope: this.lifecycleContext.scope ?? "default",
				trigger,
				error: message,
			});
			logClusterEvent("warn", "twitter_collector_pull_failed", this.lifecycleContext, {
				trigger,
				error: message,
			});
		} finally {
			this.inFlight = false;
		}
	}

	private async enrichQuotedLongFormTweets(tweets: PersistedTwitterTweet[]): Promise<void> {
		for (const tweet of tweets) {
			if (!isRecord(tweet)) {
				continue;
			}
			const quoted = tweet.quotedTweet;
			if (!isRecord(quoted) || !isLongFormTweet(quoted)) {
				continue;
			}

			const quotedId = extractTweetId(quoted);
			if (!quotedId) {
				continue;
			}

			let fullTweet = this.quotedTweetCache.get(quotedId);
			if (!fullTweet) {
				try {
					fullTweet = await this.fetchTweetById(quotedId);
					this.quotedTweetCache.set(quotedId, fullTweet);
				} catch (error) {
					logClusterEvent("warn", "twitter_collector_quoted_read_failed", this.lifecycleContext, {
						quotedId,
						error: error instanceof Error ? error.message : String(error),
					});
					continue;
				}
			}

			tweet.quotedTweet = { ...fullTweet };
		}
	}

	private async fetchForYouTimeline(): Promise<unknown> {
		const args = [
			...this.birdGlobalArgs,
			"home",
			"--count",
			String(this.config.pullCount),
			"--json",
			"--plain",
		];
		const result = await runBirdCommand(args, this.config.commandTimeoutMs);
		if (result.code !== 0) {
			throw new Error(formatBirdFailure("bird home failed", result));
		}

		const stdout = result.stdout.trim();
		if (!stdout) {
			throw new Error("bird home returned empty output");
		}

		try {
			return JSON.parse(stdout) as unknown;
		} catch (error) {
			throw new Error(
				`bird home returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async fetchTweetById(tweetId: string): Promise<Record<string, unknown>> {
		const args = [
			...this.birdGlobalArgs,
			"read",
			tweetId,
			"--json",
			"--plain",
		];
		const result = await runBirdCommand(args, this.config.commandTimeoutMs);
		if (result.code !== 0) {
			throw new Error(formatBirdFailure(`bird read failed (${tweetId})`, result));
		}

		const stdout = result.stdout.trim();
		if (!stdout) {
			throw new Error(`bird read returned empty output (${tweetId})`);
		}

		let payload: unknown;
		try {
			payload = JSON.parse(stdout) as unknown;
		} catch (error) {
			throw new Error(
				`bird read returned invalid JSON (${tweetId}): ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		if (!isRecord(payload) || !looksLikeTweetRecord(payload)) {
			throw new Error(`bird read output missing tweet object (${tweetId})`);
		}

		return payload;
	}
}

function validateCollectorConfig(config: TwitterCollectorConfig, context: ClusterLogContext): boolean {
	if (!config.enabled) {
		return false;
	}
	if (config.pullCount <= 0) {
		logClusterEvent("warn", "twitter_collector_disabled_invalid_pull_count", context, {
			pullCount: config.pullCount,
		});
		return false;
	}
	if (config.pullIntervalMinutes <= 0) {
		logClusterEvent("warn", "twitter_collector_disabled_invalid_interval", context, {
			pullIntervalMinutes: config.pullIntervalMinutes,
		});
		return false;
	}
	return true;
}

export async function maybeStartTwitterCollector(
	context: ClusterLogContext,
): Promise<TwitterCollectorHandle | null> {
	let configObject: Record<string, unknown>;
	try {
		configObject = await loadMonoPilotConfigObject();
	} catch (error) {
		logClusterEvent("warn", "twitter_collector_config_load_failed", context, {
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}

	const config = extractTwitterCollectorConfig(configObject);
	if (!validateCollectorConfig(config, context)) {
		return null;
	}

	const collector = new TwitterCollector(config, context);
	try {
		await collector.start();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		emitClusterV2TwitterCollectorStartupFailed({
			scope: context.scope ?? "default",
			error: message,
		});
		logClusterEvent("warn", "twitter_collector_start_failed", context, {
			error: message,
			action: "skip_until_next_cluster_init",
		});
		return null;
	}

	return collector;
}