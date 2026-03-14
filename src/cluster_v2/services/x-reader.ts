import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { extractTwitterCollectorConfig, type TwitterCollectorConfig } from "../../config/twitter.js";
import { loadMonoPilotConfigObject } from "../../config/mono-pilot.js";
import {
	emitClusterV2TwitterCollectorStartupFailed,
	emitClusterV2TwitterPullBatch,
	emitClusterV2TwitterPullFailed,
} from "../events.js";
import { logClusterEvent, type ClusterLogContext } from "../observability.js";
import type { ServiceDescriptor } from "../rpc.js";

interface BirdCommandResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

type PersistedTwitterTweet = Record<string, unknown>;

interface ArchiveTweetSnapshot {
	hasTweetFullField: boolean;
}

interface ResolvedShortLinkMapping {
	shortUrl: string;
	resolvedUrl: string | null;
	statusId: string | null;
}

interface PersistedTwitterBatch {
	seq: number;
	fetchedAt: string;
	snapshotId: string;
	feed: "for_you" | "following";
	requestedCount: number;
	receivedCount: number;
	tweets: PersistedTwitterTweet[];
	raw?: unknown;
}

type TimelineFeed = "for_you" | "following";

interface TimelineFetchResult {
	feed: TimelineFeed;
	payload: unknown;
	fetchedTweets: PersistedTwitterTweet[];
}

function oppositeTimelineFeed(feed: TimelineFeed): TimelineFeed {
	return feed === "for_you" ? "following" : "for_you";
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

function readNestedRecord(record: Record<string, unknown>, path: string[]): Record<string, unknown> | null {
	let current: unknown = record;
	for (const key of path) {
		if (!isRecord(current) || !(key in current)) {
			return null;
		}
		current = current[key];
	}
	return isRecord(current) ? current : null;
}

function readNestedArray(record: Record<string, unknown>, path: string[]): unknown[] | null {
	let current: unknown = record;
	for (const key of path) {
		if (!isRecord(current) || !(key in current)) {
			return null;
		}
		current = current[key];
	}
	return Array.isArray(current) ? current : null;
}

function firstNonEmptyString(candidates: Array<string | null | undefined>): string | null {
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.trim().length > 0) {
			return candidate;
		}
	}
	return null;
}

function formatLocalDateStamp(date: Date): string {
	const year = String(date.getFullYear());
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function shiftDate(date: Date, dayOffset: number): Date {
	const shifted = new Date(date);
	shifted.setDate(shifted.getDate() + dayOffset);
	return shifted;
}

function listRecentDateStamps(now: Date, dayCount: number): string[] {
	const result: string[] = [];
	for (let index = 0; index < dayCount; index += 1) {
		result.push(formatLocalDateStamp(shiftDate(now, -index)));
	}
	return result;
}

function resolveDailyArchivePath(outputPath: string, dateStamp: string): string {
	const parsed = parse(outputPath);
	const dir = parsed.dir;
	const baseName = parsed.name || parsed.base || "home";
	const extension = parsed.ext || ".jsonl";
	return join(dir, `${baseName}.${dateStamp}${extension}`);
}

function hasOwnField(record: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

function hasTweetFullField(record: Record<string, unknown>): boolean {
	return hasOwnField(record, "tweetFull");
}

function toLineRecord(line: string): Record<string, unknown> | null {
	const trimmed = line.trim();
	if (!trimmed) {
		return null;
	}

	try {
		const parsed = JSON.parse(trimmed) as unknown;
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

interface AsyncDisposableTempDir {
	path: string;
	remove(): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;
}

async function createAsyncDisposableTempDir(prefix: string): Promise<AsyncDisposableTempDir> {
	const path = await mkdtemp(prefix);
	let removed = false;

	const remove = async () => {
		if (removed) {
			return;
		}
		removed = true;
		await rm(path, { recursive: true, force: true });
	};

	return {
		path,
		remove,
		[Symbol.asyncDispose]: remove,
	};
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

function runBirdCommandToFile(
	args: string[],
	timeoutMs: number,
	outputPath: string,
): Promise<Omit<BirdCommandResult, "stdout">> {
	return new Promise((resolve, reject) => {
		let stderr = "";
		let timedOut = false;
		let stdoutFd: number;

		try {
			stdoutFd = openSync(outputPath, "w");
		} catch (error) {
			reject(error);
			return;
		}

		const child = spawn("bird", args, {
			stdio: ["ignore", stdoutFd, "pipe"],
		});

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		timer.unref();

		const closeStdoutFd = () => {
			try {
				closeSync(stdoutFd);
			} catch {
				// no-op; best-effort cleanup for temporary stdout fd
			}
		};

		if (!child.stderr) {
			clearTimeout(timer);
			closeStdoutFd();
			reject(new Error("bird stderr stream is unavailable"));
			return;
		}

		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});

		child.on("error", (error) => {
			clearTimeout(timer);
			closeStdoutFd();
			reject(error);
		});

		child.on("close", (code, signal) => {
			clearTimeout(timer);
			closeStdoutFd();
			resolve({
				code,
				signal,
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

function extractStatusIdFromUrl(url: string): string | null {
	const normalized = url.trim();
	if (!normalized) {
		return null;
	}

	const matchedUserStatus = normalized.match(
		/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status\/(\d+)/i,
	);
	if (matchedUserStatus?.[1]) {
		return matchedUserStatus[1];
	}

	const matchedWebStatus = normalized.match(
		/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/i\/web\/status\/(\d+)/i,
	);
	if (matchedWebStatus?.[1]) {
		return matchedWebStatus[1];
	}

	return null;
}

function extractTcoUrlsFromText(text: string | null): string[] {
	if (!text) {
		return [];
	}

	const deduped = new Set<string>();
	const pattern = /https?:\/\/t\.co\/[A-Za-z0-9]+/gi;
	pattern.lastIndex = 0;
	let matched: RegExpExecArray | null;
	while ((matched = pattern.exec(text)) !== null) {
		const url = matched[0]?.trim();
		if (url) {
			deduped.add(url);
		}
	}

	return [...deduped];
}

function extractBestFullText(record: Record<string, unknown>): string | null {
	const raw = isRecord(record._raw) ? record._raw : null;
	const rawRetweeted = raw
		? readNestedRecord(raw, ["legacy", "retweeted_status_result", "result"])
		: null;

	return firstNonEmptyString([
		readNestedString(record, ["note_tweet", "note_tweet_results", "result", "text"]),
		readNestedString(record, ["note_tweet_results", "result", "text"]),
		rawRetweeted ? readNestedString(rawRetweeted, ["note_tweet", "note_tweet_results", "result", "text"]) : null,
		rawRetweeted ? readNestedString(rawRetweeted, ["legacy", "full_text"]) : null,
		rawRetweeted ? readString(rawRetweeted.text) : null,
		raw ? readNestedString(raw, ["note_tweet", "note_tweet_results", "result", "text"]) : null,
		raw ? readNestedString(raw, ["note_tweet_results", "result", "text"]) : null,
		readNestedString(record, ["legacy", "full_text"]),
		readString(record.full_text),
		raw ? readNestedString(raw, ["legacy", "full_text"]) : null,
		readString(record.text),
	]);
}

function extractBestText(record: Record<string, unknown>): string | null {
	return firstNonEmptyString([
		readString(record.text),
		readString(record.full_text),
		readNestedString(record, ["legacy", "full_text"]),
		readNestedString(record, ["legacy", "text"]),
	]);
}

function extractAuthorName(record: Record<string, unknown>): string | null {
	const author = isRecord(record.author) ? record.author : null;
	if (!author) {
		return null;
	}

	return firstNonEmptyString([readString(author.name), readString(author.screen_name)]);
}

function extractCreatedAt(record: Record<string, unknown>): string | null {
	return firstNonEmptyString([
		readString(record.createdAt),
		readString(record.created_at),
		readNestedString(record, ["legacy", "created_at"]),
	]);
}

function extractBestMedia(record: Record<string, unknown>): unknown[] | null {
	if (Array.isArray(record.media)) {
		return record.media.map((item) => (isRecord(item) ? { ...item } : item));
	}

	const raw = isRecord(record._raw) ? record._raw : null;
	const rawRetweeted = raw
		? readNestedRecord(raw, ["legacy", "retweeted_status_result", "result"])
		: null;

	const candidates: Array<unknown[] | null> = [
		raw ? readNestedArray(raw, ["legacy", "extended_entities", "media"]) : null,
		rawRetweeted ? readNestedArray(rawRetweeted, ["media"]) : null,
		rawRetweeted ? readNestedArray(rawRetweeted, ["legacy", "extended_entities", "media"]) : null,
	];

	for (const candidate of candidates) {
		if (Array.isArray(candidate) && candidate.length > 0) {
			return candidate.map((item) => (isRecord(item) ? { ...item } : item));
		}
	}

	return null;
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
	private readonly archiveWindowDays = 2;
	private readonly tweetFullCache = new Map<string, Record<string, unknown>>();
	private preferredTimelineFeed: TimelineFeed = "for_you";

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
				fallbackFeed: "following",
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
			const archiveIndex = await this.loadRecentArchiveTweetIndex();
			const timeline = await this.fetchTimelineWithFallback();
			const payload = timeline.payload;
			const fetchedTweets = timeline.fetchedTweets;
			const { tweets, skippedArchivedCount, keptForBackfillCount } = this.filterTweetsByArchiveIndex(
				fetchedTweets,
				archiveIndex,
			);
			await this.enrichTweetsDepthOne(tweets);

			if (tweets.length === 0) {
				emitClusterV2TwitterPullBatch({
					scope: this.lifecycleContext.scope ?? "default",
					count: 0,
					requestedCount: this.config.pullCount,
					sequence: this.seq,
				});
				logClusterEvent("info", "twitter_collector_pull_dedup_skipped_all", this.lifecycleContext, {
					trigger,
					feed: timeline.feed,
					requestedCount: this.config.pullCount,
					fetchedCount: fetchedTweets.length,
					skippedArchivedCount,
					keptForBackfillCount,
					archiveWindowDays: this.archiveWindowDays,
					durationMs: Date.now() - startedAt,
				});
				return;
			}

			const fetchedAt = new Date().toISOString();
			const seq = ++this.seq;
			const record: PersistedTwitterBatch = {
				seq,
				fetchedAt,
				snapshotId: `${fetchedAt}-${seq}`,
				feed: timeline.feed,
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
				feed: timeline.feed,
				requestedCount: this.config.pullCount,
				fetchedCount: fetchedTweets.length,
				receivedCount: tweets.length,
				skippedArchivedCount,
				keptForBackfillCount,
				archiveWindowDays: this.archiveWindowDays,
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

	private filterTweetsByArchiveIndex(
		tweets: PersistedTwitterTweet[],
		archiveIndex: Map<string, ArchiveTweetSnapshot>,
	): {
		tweets: PersistedTwitterTweet[];
		skippedArchivedCount: number;
		keptForBackfillCount: number;
	} {
		const selected: PersistedTwitterTweet[] = [];
		let skippedArchivedCount = 0;
		let keptForBackfillCount = 0;

		for (const tweet of tweets) {
			if (!isRecord(tweet)) {
				selected.push(tweet);
				continue;
			}

			const tweetId = extractTweetId(tweet);
			if (!tweetId) {
				selected.push(tweet);
				continue;
			}

			const snapshot = archiveIndex.get(tweetId);
			if (!snapshot) {
				selected.push(tweet);
				continue;
			}

			if (snapshot.hasTweetFullField) {
				skippedArchivedCount += 1;
				continue;
			}

			keptForBackfillCount += 1;
			selected.push(tweet);
		}

		return {
			tweets: selected,
			skippedArchivedCount,
			keptForBackfillCount,
		};
	}

	private async loadRecentArchiveTweetIndex(now = new Date()): Promise<Map<string, ArchiveTweetSnapshot>> {
		const index = new Map<string, ArchiveTweetSnapshot>();
		const dateStamps = listRecentDateStamps(now, this.archiveWindowDays);

		for (const dateStamp of dateStamps) {
			const archivePath = resolveDailyArchivePath(this.config.outputPath, dateStamp);
			let content: string;
			try {
				content = await readFile(archivePath, "utf-8");
			} catch {
				continue;
			}

			const lines = content.split("\n");
			for (const line of lines) {
				const record = toLineRecord(line);
				if (!record) {
					continue;
				}

				const tweets = record.tweets;
				if (!Array.isArray(tweets)) {
					continue;
				}

				for (const tweet of tweets) {
					if (!isRecord(tweet)) {
						continue;
					}
					const tweetId = extractTweetId(tweet);
					if (!tweetId) {
						continue;
					}

					const previous = index.get(tweetId);
					index.set(tweetId, {
						hasTweetFullField: Boolean(previous?.hasTweetFullField || hasTweetFullField(tweet)),
					});
				}
			}
		}

		return index;
	}

	private async enrichTweetsDepthOne(tweets: PersistedTwitterTweet[]): Promise<void> {
		for (const tweet of tweets) {
			if (!isRecord(tweet)) {
				continue;
			}

			const mainId = extractTweetId(tweet);
			let fullMain: Record<string, unknown> | null = null;
			if (mainId) {
				fullMain = await this.loadTweetFull(mainId, "tweetFull");
				if (fullMain) {
					tweet.tweetFull = { ...fullMain };
				}
			}

			let quotedId: string | null = null;
			const quoted = tweet.quotedTweet;
			if (isRecord(quoted)) {
				quotedId = extractTweetId(quoted);
				if (quotedId) {
					const fullQuoted = await this.loadTweetFull(quotedId, "quotedTweetFull");
					if (fullQuoted) {
						// Keep timeline snippet in quotedTweet; attach fetched full tweet separately.
						tweet.quotedTweetFull = { ...fullQuoted };
					}
				}
			}

			const shortLinks = this.collectShortLinksForTweet(tweet, fullMain);
			if (shortLinks.length === 0) {
				continue;
			}

			const shortLinkMappings = await this.resolveShortLinkMappings(shortLinks);
			if (shortLinkMappings.length > 0) {
				const tweetFullByShortLinkTweetId = new Map<string, Record<string, unknown> | null>();
				const enrichedShortLinkMappings: Record<string, unknown>[] = [];

			for (const mapping of shortLinkMappings) {
				const enriched: Record<string, unknown> = {
					shortUrl: mapping.shortUrl,
					resolvedUrl: mapping.resolvedUrl,
					tweetId: mapping.statusId,
				};

				const statusId = mapping.statusId;
				let mappingTweetFull: Record<string, unknown> | null = null;
				if (statusId && statusId !== mainId) {
					let shortLinkTweetFull = tweetFullByShortLinkTweetId.get(statusId);
					if (shortLinkTweetFull === undefined) {
						shortLinkTweetFull = await this.loadTweetFull(statusId, "shortLinkTweetFull");
						tweetFullByShortLinkTweetId.set(statusId, shortLinkTweetFull ?? null);
					}

					if (shortLinkTweetFull) {
						mappingTweetFull = shortLinkTweetFull;
						enriched.tweetFull = { ...mappingTweetFull };
					}
				} else if (statusId && statusId === mainId && fullMain) {
					mappingTweetFull = fullMain;
				}

				if (mappingTweetFull) {
					const author = extractAuthorName(mappingTweetFull);
					if (author) {
						enriched.author = author;
					}

					const createdAt = extractCreatedAt(mappingTweetFull);
					if (createdAt) {
						enriched.createdAt = createdAt;
					}
				}

				enrichedShortLinkMappings.push(enriched);
			}

				tweet.shortLinkMappings = enrichedShortLinkMappings;
			}
		}
	}

	private collectShortLinksForTweet(
		tweet: Record<string, unknown>,
		tweetFull: Record<string, unknown> | null,
	): string[] {
		const links = new Set<string>();

		for (const shortUrl of extractTcoUrlsFromText(readString(tweet.text))) {
			links.add(shortUrl);
		}

		if (tweetFull) {
			for (const shortUrl of extractTcoUrlsFromText(readString(tweetFull.text))) {
				links.add(shortUrl);
			}
			for (const shortUrl of extractTcoUrlsFromText(readString(tweetFull.fullText))) {
				links.add(shortUrl);
			}
		}

		return [...links];
	}

	private async resolveShortLinkMappings(shortLinks: string[]): Promise<ResolvedShortLinkMapping[]> {
		const mappings: ResolvedShortLinkMapping[] = [];
		for (const shortUrl of shortLinks) {
			const mapping = await this.resolveShortLinkMapping(shortUrl);
			mappings.push(mapping);
		}
		return mappings;
	}

	private async resolveShortLinkMapping(
		shortUrl: string,
	): Promise<ResolvedShortLinkMapping> {
		let currentUrl = shortUrl;
		let resolvedUrl: string | null = shortUrl;
		const maxRedirects = 8;

		for (let hop = 0; hop < maxRedirects; hop += 1) {
			const directStatusId = extractStatusIdFromUrl(currentUrl);
			if (directStatusId) {
				return { shortUrl, resolvedUrl: currentUrl, statusId: directStatusId };
			}

			let response: Response;
			try {
				const timeoutMs = Math.max(500, this.config.requestTimeoutMs ?? this.config.commandTimeoutMs);
				response = await fetch(currentUrl, {
					method: "GET",
					redirect: "manual",
					signal: AbortSignal.timeout(timeoutMs),
				});
			} catch {
				return { shortUrl, resolvedUrl, statusId: null };
			}

			if (response.url) {
				resolvedUrl = response.url;
			}

			const responseStatusId = extractStatusIdFromUrl(response.url);
			if (responseStatusId) {
				void response.body?.cancel().catch(() => {
					// no-op
				});
				return { shortUrl, resolvedUrl: response.url, statusId: responseStatusId };
			}

			const location = response.headers.get("location");
			const isRedirect = response.status >= 300 && response.status < 400;
			void response.body?.cancel().catch(() => {
				// no-op
			});

			if (!isRedirect || !location) {
				return { shortUrl, resolvedUrl, statusId: null };
			}

			try {
				currentUrl = new URL(location, currentUrl).toString();
				resolvedUrl = currentUrl;
			} catch {
				return { shortUrl, resolvedUrl, statusId: null };
			}
		}

		return { shortUrl, resolvedUrl, statusId: null };
	}

	private async loadTweetFull(
		tweetId: string,
		targetField: "tweetFull" | "quotedTweetFull" | "shortLinkTweetFull",
	): Promise<Record<string, unknown> | null> {
		const cached = this.tweetFullCache.get(tweetId);
		if (cached) {
			return cached;
		}

		const maxAttempts = 2; // first try + one retry
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			try {
				const fullTweet = await this.fetchTweetById(tweetId);
				this.tweetFullCache.set(tweetId, fullTweet);
				return fullTweet;
			} catch (error) {
				lastError = error;
				if (attempt < maxAttempts) {
					logClusterEvent("info", "twitter_collector_tweet_read_retry", this.lifecycleContext, {
						tweetId,
						targetField,
						attempt,
						nextAttempt: attempt + 1,
						error: error instanceof Error ? error.message : String(error),
					});
					await new Promise<void>((resolve) => setTimeout(resolve, 200));
				}
			}
		}

		logClusterEvent("warn", "twitter_collector_tweet_read_failed", this.lifecycleContext, {
			tweetId,
			targetField,
			attempts: maxAttempts,
			error: lastError instanceof Error ? lastError.message : String(lastError),
		});
		return null;
	}

	private async fetchTimelineWithFallback(): Promise<TimelineFetchResult> {
		const currentFeed = this.preferredTimelineFeed;
		const currentPayload = await this.fetchHomeTimeline(currentFeed === "following");
		const currentTweets = parseTweetsFromPayload(currentPayload, this.config.pullCount);
		if (currentTweets.length > 0) {
			return {
				feed: currentFeed,
				payload: currentPayload,
				fetchedTweets: currentTweets,
			};
		}

		const nextFeed = oppositeTimelineFeed(currentFeed);
		logClusterEvent("info", "twitter_collector_feed_empty_switch", this.lifecycleContext, {
			fromFeed: currentFeed,
			toFeed: nextFeed,
			requestedCount: this.config.pullCount,
			fetchedCount: currentTweets.length,
		});

		try {
			const nextPayload = await this.fetchHomeTimeline(nextFeed === "following");
			const nextTweets = parseTweetsFromPayload(nextPayload, this.config.pullCount);
			this.preferredTimelineFeed = nextFeed;
			return {
				feed: nextFeed,
				payload: nextPayload,
				fetchedTweets: nextTweets,
			};
		} catch (error) {
			logClusterEvent("warn", "twitter_collector_feed_switch_failed", this.lifecycleContext, {
				fromFeed: currentFeed,
				toFeed: nextFeed,
				error: error instanceof Error ? error.message : String(error),
				requestedCount: this.config.pullCount,
				action: "keep_current_feed_empty_batch",
			});
			return {
				feed: currentFeed,
				payload: currentPayload,
				fetchedTweets: currentTweets,
			};
		}
	}

	private async fetchHomeTimeline(useFollowingFeed: boolean): Promise<unknown> {
		const args = [
			...this.birdGlobalArgs,
			"home",
			...(useFollowingFeed ? ["--following"] : []),
			"--count",
			String(this.config.pullCount),
			"--json",
			"--plain",
		];
		const result = await runBirdCommand(args, this.config.commandTimeoutMs);
		if (result.code !== 0) {
			throw new Error(formatBirdFailure(`bird home${useFollowingFeed ? " --following" : ""} failed`, result));
		}

		const stdout = result.stdout.trim();
		if (!stdout) {
			throw new Error(`bird home${useFollowingFeed ? " --following" : ""} returned empty output`);
		}

		try {
			return JSON.parse(stdout) as unknown;
		} catch (error) {
			throw new Error(
				`bird home${useFollowingFeed ? " --following" : ""} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async fetchTweetById(tweetId: string): Promise<Record<string, unknown>> {
		const args = [
			...this.birdGlobalArgs,
			"read",
			tweetId,
			"--json-full",
			"--plain",
		];
		const tempPrefix = join(tmpdir(), "mono-pilot-bird-read-");
		await using tempDir = await createAsyncDisposableTempDir(tempPrefix);
		const tempOutputPath = join(tempDir.path, `${tweetId}.json`);

		const result = await runBirdCommandToFile(args, this.config.commandTimeoutMs, tempOutputPath);
		if (result.code !== 0) {
			throw new Error(formatBirdFailure(`bird read failed (${tweetId})`, { ...result, stdout: "" }));
		}

		const stdout = (await readFile(tempOutputPath, "utf-8")).trim();
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

		const normalized: Record<string, unknown> = {};
		const text = extractBestText(payload);
		const fullText = extractBestFullText(payload);
		const media = extractBestMedia(payload);
		const author = extractAuthorName(payload);
		const createdAt = extractCreatedAt(payload);

		if (text) {
			normalized.text = text;
		}

		if (fullText) {
			normalized.fullText = fullText;
		}

		if (media) {
			normalized.media = media;
		}

		if (author) {
			normalized.author = { name: author };
		}

		if (createdAt) {
			normalized.createdAt = createdAt;
		}

		return normalized;
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
