import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";
import type { TwitterCollectorConfig } from "../../config/twitter.js";

type NotifyLevel = "info" | "warning" | "error";

const COOPERATIVE_YIELD_EVERY_LINES = 20;
const COOPERATIVE_YIELD_EVERY_TWEETS = 20;
const ITEM_PROGRESS_NOTIFY_EVERY_TWEETS = 4;

interface BirdCommandResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

interface BackfillStats {
	filesScanned: number;
	filesUpdated: number;
	tweetsScanned: number;
	tweetsUpdated: number;
	tweetFullAdded: number;
	quotedTweetFullAdded: number;
	shortLinkMappingsAdded: number;
	shortLinkTweetFullAdded: number;
	tweetReadAttempts: number;
	tweetReadSuccess: number;
	tweetReadFailed: number;
	shortLinkResolveAttempts: number;
	shortLinkResolveFailed: number;
}

interface RunDigestBackfillOptions {
	twitterConfig: TwitterCollectorConfig;
	date?: string;
	file?: string;
	notify: (message: string, level: NotifyLevel) => void;
}

interface ProcessFileResult {
	changed: boolean;
	tweetsScanned: number;
	tweetsUpdated: number;
	tweetFullAdded: number;
	quotedTweetFullAdded: number;
	shortLinkMappingsAdded: number;
	shortLinkTweetFullAdded: number;
}

interface ResolvedShortLinkMapping {
	shortUrl: string;
	resolvedUrl: string | null;
	statusId: string | null;
}

interface AsyncDisposableTempDir {
	path: string;
	remove(): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;
}

async function cooperativeYield(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
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

function expandAndResolvePath(rawPath: string): string {
	const trimmed = rawPath.trim();
	if (!trimmed) {
		return trimmed;
	}

	let expanded = trimmed;
	if (expanded === "~") {
		expanded = homedir();
	} else if (expanded.startsWith("~/")) {
		expanded = join(homedir(), expanded.slice(2));
	}

	return isAbsolute(expanded) ? expanded : resolve(expanded);
}

function buildDailyArchivePath(baseOutputPath: string, dateStamp: string): string {
	const parsed = parse(baseOutputPath);
	const ext = parsed.ext || ".jsonl";
	const name = parsed.name || parsed.base || "home";
	return join(parsed.dir, `${name}.${dateStamp}${ext}`);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function listArchiveFiles(baseOutputPath: string): Promise<string[]> {
	const parsed = parse(baseOutputPath);
	const ext = parsed.ext || ".jsonl";
	const name = parsed.name || parsed.base || "home";
	const pattern = new RegExp(`^${escapeRegExp(name)}\\.(\\d{4}-\\d{2}-\\d{2})${escapeRegExp(ext)}$`);

	let entries: string[];
	try {
		entries = await readdir(parsed.dir);
	} catch {
		return [];
	}

	return entries
		.filter((entry) => pattern.test(entry))
		.map((entry) => join(parsed.dir, entry))
		.sort((a, b) => a.localeCompare(b));
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
				// no-op
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

	const matchedWebStatus = normalized.match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/i\/web\/status\/(\d+)/i);
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
	const rawRetweeted = raw ? readNestedRecord(raw, ["legacy", "retweeted_status_result", "result"]) : null;

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
	const rawRetweeted = raw ? readNestedRecord(raw, ["legacy", "retweeted_status_result", "result"]) : null;

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

function collectShortLinksForTweet(tweet: Record<string, unknown>, tweetFull: Record<string, unknown> | null): string[] {
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

function hasTweetFullLikeField(value: unknown): boolean {
	if (!isRecord(value)) {
		return false;
	}
	return Boolean(readString(value.text) || readString(value.fullText) || Array.isArray(value.media));
}

async function verifyBirdAccess(config: TwitterCollectorConfig): Promise<void> {
	const args = [...buildBirdGlobalArgs(config), "check"];
	const result = await runBirdCommand(args, config.commandTimeoutMs);
	if (result.code !== 0) {
		throw new Error(formatBirdFailure("bird check failed", result));
	}
}

async function fetchTweetById(
	tweetId: string,
	config: TwitterCollectorConfig,
	stats: BackfillStats,
): Promise<Record<string, unknown> | null> {
	stats.tweetReadAttempts += 1;

	const args = [...buildBirdGlobalArgs(config), "read", tweetId, "--json-full", "--plain"];
	const tempPrefix = join(tmpdir(), "mono-pilot-digest-backfill-");

	try {
		await using tempDir = await createAsyncDisposableTempDir(tempPrefix);
		const tempOutputPath = join(tempDir.path, `${tweetId}.json`);

		const result = await runBirdCommandToFile(args, config.commandTimeoutMs, tempOutputPath);
		if (result.code !== 0) {
			const asFullResult: BirdCommandResult = {
				code: result.code,
				signal: result.signal,
				stdout: "",
				stderr: result.stderr,
				timedOut: result.timedOut,
			};
			throw new Error(formatBirdFailure(`bird read failed (${tweetId})`, asFullResult));
		}

		const stdout = (await readFile(tempOutputPath, "utf-8")).trim();
		if (!stdout) {
			throw new Error(`bird read returned empty output (${tweetId})`);
		}

		const payload = JSON.parse(stdout) as unknown;
		if (!isRecord(payload)) {
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

		stats.tweetReadSuccess += 1;
		return normalized;
	} catch {
		stats.tweetReadFailed += 1;
		return null;
	}
}

async function resolveShortLinkMapping(
	shortUrl: string,
	config: TwitterCollectorConfig,
	stats: BackfillStats,
): Promise<ResolvedShortLinkMapping> {
	stats.shortLinkResolveAttempts += 1;

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
			const timeoutMs = Math.max(500, config.requestTimeoutMs ?? config.commandTimeoutMs);
			response = await fetch(currentUrl, {
				method: "GET",
				redirect: "manual",
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch {
			stats.shortLinkResolveFailed += 1;
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
			stats.shortLinkResolveFailed += 1;
			return { shortUrl, resolvedUrl, statusId: null };
		}
	}

	return { shortUrl, resolvedUrl, statusId: null };
}

function readExistingShortLinkMappings(tweet: Record<string, unknown>): Array<Record<string, unknown>> {
	if (!Array.isArray(tweet.shortLinkMappings)) {
		return [];
	}
	return tweet.shortLinkMappings.filter((item): item is Record<string, unknown> => isRecord(item));
}

async function fillMissingTweetField(
	tweetId: string | null,
	cache: Map<string, Record<string, unknown> | null>,
	config: TwitterCollectorConfig,
	stats: BackfillStats,
): Promise<Record<string, unknown> | null> {
	if (!tweetId) {
		return null;
	}

	if (cache.has(tweetId)) {
		return cache.get(tweetId) ?? null;
	}

	const fetched = await fetchTweetById(tweetId, config, stats);
	cache.set(tweetId, fetched ?? null);
	return fetched;
}

async function enrichShortLinkMappings(
	tweet: Record<string, unknown>,
	tweetFull: Record<string, unknown> | null,
	selfTweetId: string | null,
	cache: Map<string, Record<string, unknown> | null>,
	config: TwitterCollectorConfig,
	stats: BackfillStats,
): Promise<{ mappings: Record<string, unknown>[]; changed: boolean; addedMappings: number; addedTweetFull: number }> {
	const existingMappings = readExistingShortLinkMappings(tweet);
	const byShortUrl = new Map<string, Record<string, unknown>>();
	const order: string[] = [];

	for (const mapping of existingMappings) {
		const shortUrl = readString(mapping.shortUrl);
		if (!shortUrl) {
			continue;
		}
		if (!byShortUrl.has(shortUrl)) {
			byShortUrl.set(shortUrl, { ...mapping, shortUrl });
			order.push(shortUrl);
		}
	}

	const detectedShortLinks = collectShortLinksForTweet(tweet, tweetFull);
	for (const shortUrl of detectedShortLinks) {
		if (!byShortUrl.has(shortUrl)) {
			byShortUrl.set(shortUrl, { shortUrl, resolvedUrl: shortUrl, tweetId: null });
			order.push(shortUrl);
		}
	}

	let changed = false;
	let addedMappings = 0;
	let addedTweetFull = 0;

	for (const shortUrl of order) {
		const mapping = byShortUrl.get(shortUrl);
		if (!mapping) {
			continue;
		}

		const existingResolvedUrl = readString(mapping.resolvedUrl) ?? shortUrl;
		let tweetId = readString(mapping.tweetId);

		if (!tweetId) {
			tweetId = extractStatusIdFromUrl(existingResolvedUrl);
			if (tweetId) {
				mapping.tweetId = tweetId;
				changed = true;
			}
		}

		if (!tweetId && (!readString(mapping.resolvedUrl) || !readString(mapping.tweetId))) {
			const resolved = await resolveShortLinkMapping(shortUrl, config, stats);
			if ((resolved.resolvedUrl ?? null) !== (readString(mapping.resolvedUrl) ?? null)) {
				mapping.resolvedUrl = resolved.resolvedUrl;
				changed = true;
			}
			if ((resolved.statusId ?? null) !== (readString(mapping.tweetId) ?? null)) {
				mapping.tweetId = resolved.statusId;
				changed = true;
			}
			tweetId = resolved.statusId;
		}

		if (tweetId && tweetId !== selfTweetId && !hasTweetFullLikeField(mapping.tweetFull)) {
			const fetched = await fillMissingTweetField(tweetId, cache, config, stats);
			if (fetched) {
				mapping.tweetFull = { ...fetched };
				changed = true;
				addedTweetFull += 1;
			}
		}

		const mappingTweetFull = isRecord(mapping.tweetFull)
			? mapping.tweetFull
			: tweetId && tweetId === selfTweetId && tweetFull
				? tweetFull
				: null;

		if (mappingTweetFull) {
			const author = extractAuthorName(mappingTweetFull);
			if (author !== (readString(mapping.author) ?? null)) {
				if (author) {
					mapping.author = author;
				} else {
					delete mapping.author;
				}
				changed = true;
			}

			const createdAt = extractCreatedAt(mappingTweetFull);
			if (createdAt !== (readString(mapping.createdAt) ?? null)) {
				if (createdAt) {
					mapping.createdAt = createdAt;
				} else {
					delete mapping.createdAt;
				}
				changed = true;
			}
		}
	}

	if (existingMappings.length === 0 && order.length > 0) {
		addedMappings += order.length;
		changed = true;
	} else {
		addedMappings += Math.max(0, order.length - existingMappings.length);
	}

	const mappings = order.map((shortUrl) => byShortUrl.get(shortUrl) as Record<string, unknown>);
	return { mappings, changed, addedMappings, addedTweetFull };
}

async function backfillTweet(
	tweet: Record<string, unknown>,
	cache: Map<string, Record<string, unknown> | null>,
	config: TwitterCollectorConfig,
	stats: BackfillStats,
): Promise<{ changed: boolean; tweetFullAdded: boolean; quotedTweetFullAdded: boolean; mappingsAdded: number; shortLinkTweetFullAdded: number }> {
	let changed = false;
	let tweetFullAdded = false;
	let quotedTweetFullAdded = false;

	const tweetId = extractTweetId(tweet);
	let tweetFull = isRecord(tweet.tweetFull) ? tweet.tweetFull : null;
	if (!hasTweetFullLikeField(tweetFull) && tweetId) {
		const fetched = await fillMissingTweetField(tweetId, cache, config, stats);
		if (fetched) {
			tweet.tweetFull = { ...fetched };
			tweetFull = fetched;
			changed = true;
			tweetFullAdded = true;
		}
	}

	const quoted = isRecord(tweet.quotedTweet) ? tweet.quotedTweet : null;
	let quotedFull = isRecord(tweet.quotedTweetFull) ? tweet.quotedTweetFull : null;
	if (quoted && !hasTweetFullLikeField(quotedFull)) {
		const quotedId = extractTweetId(quoted);
		const fetchedQuoted = await fillMissingTweetField(quotedId, cache, config, stats);
		if (fetchedQuoted) {
			tweet.quotedTweetFull = { ...fetchedQuoted };
			quotedFull = fetchedQuoted;
			changed = true;
			quotedTweetFullAdded = true;
		}
	}

	const mappingsResult = await enrichShortLinkMappings(tweet, tweetFull, tweetId, cache, config, stats);
	if (mappingsResult.mappings.length > 0 && mappingsResult.changed) {
		tweet.shortLinkMappings = mappingsResult.mappings;
		changed = true;
	}

	return {
		changed,
		tweetFullAdded,
		quotedTweetFullAdded,
		mappingsAdded: mappingsResult.addedMappings,
		shortLinkTweetFullAdded: mappingsResult.addedTweetFull,
	};
}

async function processArchiveFile(
	filePath: string,
	cache: Map<string, Record<string, unknown> | null>,
	config: TwitterCollectorConfig,
	stats: BackfillStats,
	onTweetScanned?: (fileTweetCount: number) => void,
): Promise<ProcessFileResult> {
	const raw = await readFile(filePath, "utf-8");
	const hasTrailingNewline = raw.endsWith("\n");
	const lines = raw.split(/\r?\n/);
	if (hasTrailingNewline && lines[lines.length - 1] === "") {
		lines.pop();
	}

	let changed = false;
	let tweetsScanned = 0;
	let tweetsUpdated = 0;
	let tweetFullAdded = 0;
	let quotedTweetFullAdded = 0;
	let shortLinkMappingsAdded = 0;
	let shortLinkTweetFullAdded = 0;
	let processedLinesSinceYield = 0;
	let processedTweetsSinceYield = 0;
	let fileTweetCount = 0;

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (!line || line.trim().length === 0) {
			continue;
		}

		processedLinesSinceYield += 1;
		if (processedLinesSinceYield >= COOPERATIVE_YIELD_EVERY_LINES) {
			processedLinesSinceYield = 0;
			await cooperativeYield();
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}

		if (!isRecord(parsed) || !Array.isArray(parsed.tweets)) {
			continue;
		}

		let lineChanged = false;
		for (let tweetIndex = 0; tweetIndex < parsed.tweets.length; tweetIndex += 1) {
			const rawTweet = parsed.tweets[tweetIndex];
			if (!isRecord(rawTweet)) {
				continue;
			}

			processedTweetsSinceYield += 1;
			if (processedTweetsSinceYield >= COOPERATIVE_YIELD_EVERY_TWEETS) {
				processedTweetsSinceYield = 0;
				await cooperativeYield();
			}

			tweetsScanned += 1;
			fileTweetCount += 1;
			onTweetScanned?.(fileTweetCount);
			const result = await backfillTweet(rawTweet, cache, config, stats);
			if (result.changed) {
				lineChanged = true;
				tweetsUpdated += 1;
			}
			if (result.tweetFullAdded) {
				tweetFullAdded += 1;
			}
			if (result.quotedTweetFullAdded) {
				quotedTweetFullAdded += 1;
			}
			shortLinkMappingsAdded += result.mappingsAdded;
			shortLinkTweetFullAdded += result.shortLinkTweetFullAdded;
		}

		if (lineChanged) {
			lines[index] = JSON.stringify(parsed);
			changed = true;
		}
	}

	if (changed) {
		const nextRaw = lines.join("\n");
		await writeFile(filePath, hasTrailingNewline ? `${nextRaw}\n` : nextRaw, "utf-8");
	}

	return {
		changed,
		tweetsScanned,
		tweetsUpdated,
		tweetFullAdded,
		quotedTweetFullAdded,
		shortLinkMappingsAdded,
		shortLinkTweetFullAdded,
	};
}

export async function runDigestBackfill(options: RunDigestBackfillOptions): Promise<void> {
	const { twitterConfig, date, file, notify } = options;

	const stats: BackfillStats = {
		filesScanned: 0,
		filesUpdated: 0,
		tweetsScanned: 0,
		tweetsUpdated: 0,
		tweetFullAdded: 0,
		quotedTweetFullAdded: 0,
		shortLinkMappingsAdded: 0,
		shortLinkTweetFullAdded: 0,
		tweetReadAttempts: 0,
		tweetReadSuccess: 0,
		tweetReadFailed: 0,
		shortLinkResolveAttempts: 0,
		shortLinkResolveFailed: 0,
	};

	const targets = file
		? [expandAndResolvePath(file)]
		: date
			? [buildDailyArchivePath(twitterConfig.outputPath, date)]
			: await listArchiveFiles(twitterConfig.outputPath);

	if (targets.length === 0) {
		notify("Digest backfill: no archive files found.", "warning");
		return;
	}

	notify(`Digest backfill start: files=${targets.length} (serial mode).`, "info");

	try {
		await verifyBirdAccess(twitterConfig);
	} catch (error) {
		notify(
			`Digest backfill aborted: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return;
	}

	const tweetFullCache = new Map<string, Record<string, unknown> | null>();
	let totalTweetScanned = 0;

	for (let index = 0; index < targets.length; index += 1) {
		const filePath = targets[index] as string;
		stats.filesScanned += 1;

		notify(`Digest backfill progress: ${index + 1}/${targets.length} file=${filePath}`, "info");

		let result: ProcessFileResult;
		try {
			result = await processArchiveFile(filePath, tweetFullCache, twitterConfig, stats, (fileTweetCount) => {
				totalTweetScanned += 1;
				if (totalTweetScanned % ITEM_PROGRESS_NOTIFY_EVERY_TWEETS === 0) {
					notify(
						`Digest backfill item progress: totalTweets=${totalTweetScanned}, currentFile=${index + 1}/${targets.length}, fileTweets=${fileTweetCount}, file=${parse(filePath).base}`,
						"info",
					);
				}
			});
		} catch (error) {
			notify(
				`Digest backfill file failed: ${filePath} (${error instanceof Error ? error.message : String(error)})`,
				"warning",
			);
			continue;
		}

		stats.tweetsScanned += result.tweetsScanned;
		stats.tweetsUpdated += result.tweetsUpdated;
		stats.tweetFullAdded += result.tweetFullAdded;
		stats.quotedTweetFullAdded += result.quotedTweetFullAdded;
		stats.shortLinkMappingsAdded += result.shortLinkMappingsAdded;
		stats.shortLinkTweetFullAdded += result.shortLinkTweetFullAdded;

		if (result.changed) {
			stats.filesUpdated += 1;
		}
	}

	notify(
		`Digest backfill done: files=${stats.filesScanned}, updatedFiles=${stats.filesUpdated}, tweets=${stats.tweetsScanned}, updatedTweets=${stats.tweetsUpdated}, +tweetFull=${stats.tweetFullAdded}, +quotedTweetFull=${stats.quotedTweetFullAdded}, +shortLinkMappings=${stats.shortLinkMappingsAdded}, +shortLinkTweetFull=${stats.shortLinkTweetFullAdded}, birdRead=${stats.tweetReadAttempts}/${stats.tweetReadSuccess} ok, shortLinkResolve=${stats.shortLinkResolveAttempts} (failed=${stats.shortLinkResolveFailed}).`,
		"info",
	);
}
