import { completeSimple, type Api, type AssistantMessage, type Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { extractDigestConfig } from "../../config/digest.js";
import { loadMonoPilotConfigObject } from "../../config/mono-pilot.js";
import { extractTwitterCollectorConfig } from "../../config/twitter.js";
import { publishSystemEvent } from "../system-events.js";
import { runDigestBackfill } from "./backfill.js";

type NotifyLevel = "info" | "warning" | "error";

type ModelRegistryLike = {
	find(provider: string, modelId: string): Model<Api> | undefined;
	getApiKey(model: Model<Api>): Promise<string | undefined>;
};

type CommandContext = {
	hasUI?: boolean;
	ui?: {
		notify?: (message: string, level?: NotifyLevel) => void;
		select?: (title: string, options: string[]) => Promise<string | undefined>;
	};
	modelRegistry: ModelRegistryLike;
};

interface ParsedArgs {
	subcommand: "draft" | "backfill";
	date?: string;
	file?: string;
	concurrency?: number;
	sample?: number;
	limit?: number;
	provider?: string;
	model?: string;
	error?: string;
}

interface ClassificationItem {
	archiveFile: string;
	archiveOrder: number;
	lineNumber: number;
	batchSeq: number | null;
	tweetIndex: number;
	tweetId: string | null;
	tweet: Record<string, unknown>;
}

interface ClassificationResult {
	lineNumber: number;
	batchSeq: number | null;
	tweetIndex: number;
	tweetId: string | null;
	category: string | null;
	confidence: number;
	reason: string;
	error?: string;
	model: {
		provider: string;
		id: string;
	};
	classifiedAt: string;
}

const IRRELEVANT_CATEGORY = "无关";
const CATEGORIES = [
	"技术",
	"产品",
	"融资并购",
	"开源生态",
	"组织动态",
	"政策监管",
	"学术研究",
	IRRELEVANT_CATEGORY,
] as const;
const CATEGORY_SET = new Set<string>(CATEGORIES);
const FOCUS_CATEGORY_SET = new Set<string>(CATEGORIES.filter((category) => category !== IRRELEVANT_CATEGORY));
const DEFAULT_DEBUG_SAMPLE_SIZE = 4;
const CLASSIFICATION_TEXT_MAX_CHARS = 512;
const DIGEST_OUTPUT_DIR = join(homedir(), ".mono-pilot", "twitter");
const ENABLE_CLASSIFICATION_BRANCH = true;
const DIGEST_DATE_ALL = "all";
let digestBackfillRunning = false;
let digestDraftRunning = false;
const CLASSIFY_COOPERATIVE_YIELD_EVERY_LINES = 20;

const USAGE = [
	"Usage:",
	"  /digest draft [--date YYYY-MM-DD|all] [--file <path>]",
	"                   [--concurrency <N>] [--sample <N>]",
	"                   [--provider <name>] [--model <id>]",
	"  /digest backfill [--date YYYY-MM-DD] [--file <path>]",
	"                   (serial backfill for tweetFull/quotedTweetFull/shortLinkMappings)",
].join("\n");

const CLASSIFIER_SYSTEM_PROMPT = [
	"You classify AI-industry tweets into exactly one category.",
	`Allowed categories: ${CATEGORIES.join(" | ")}`,
	"Return strict JSON only. Do not use markdown.",
	"Format: {\"category\":\"<one allowed category>\",\"confidence\":<0..1>,\"reason\":\"<=40 chars\"}",
].join("\n");

const CLASSIFIER_LABEL_FALLBACK_PROMPT = [
	"Choose exactly one category for the tweet.",
	`Allowed categories: ${CATEGORIES.join(" | ")}`,
	"Return category name only, no extra text.",
].join("\n");

function parseArgs(raw: string): ParsedArgs {
	const tokens = raw
		.trim()
		.split(/\s+/)
		.map((token) => token.trim())
		.filter((token) => token.length > 0);

	if (tokens.length === 0) {
		return { subcommand: "draft" };
	}

	let cursor = 0;
	const first = tokens[0];
	let subcommand: "draft" | "backfill" = "draft";
	if (first && !first.startsWith("--")) {
		if (first !== "draft" && first !== "classify" && first !== "backfill") {
			return { subcommand: "draft", error: `Unknown subcommand: ${first}.\n${USAGE}` };
		}
		subcommand = first === "classify" ? "draft" : first;
		cursor = 1;
	}

	const parsed: ParsedArgs = { subcommand };
	for (let i = cursor; i < tokens.length; i += 1) {
		const token = tokens[i] ?? "";

		if (token === "--date") {
			parsed.date = tokens[i + 1];
			i += 1;
			continue;
		}
		if (token.startsWith("--date=")) {
			parsed.date = token.slice("--date=".length);
			continue;
		}

		if (token === "--file") {
			parsed.file = tokens[i + 1];
			i += 1;
			continue;
		}
		if (token.startsWith("--file=")) {
			parsed.file = token.slice("--file=".length);
			continue;
		}

		if (token === "--concurrency") {
			parsed.concurrency = toPositiveInt(tokens[i + 1]);
			i += 1;
			continue;
		}
		if (token.startsWith("--concurrency=")) {
			parsed.concurrency = toPositiveInt(token.slice("--concurrency=".length));
			continue;
		}

		if (token === "--limit") {
			parsed.limit = toPositiveInt(tokens[i + 1]);
			i += 1;
			continue;
		}
		if (token.startsWith("--limit=")) {
			parsed.limit = toPositiveInt(token.slice("--limit=".length));
			continue;
		}

		if (token === "--sample") {
			parsed.sample = toPositiveInt(tokens[i + 1]);
			i += 1;
			continue;
		}
		if (token.startsWith("--sample=")) {
			parsed.sample = toPositiveInt(token.slice("--sample=".length));
			continue;
		}

		if (token === "--provider") {
			parsed.provider = tokens[i + 1];
			i += 1;
			continue;
		}
		if (token.startsWith("--provider=")) {
			parsed.provider = token.slice("--provider=".length);
			continue;
		}

		if (token === "--model") {
			parsed.model = tokens[i + 1];
			i += 1;
			continue;
		}
		if (token.startsWith("--model=")) {
			parsed.model = token.slice("--model=".length);
			continue;
		}

		return { subcommand: "draft", error: `Unknown argument: ${token}.\n${USAGE}` };
	}

	if (parsed.date) {
		const normalizedDate = parsed.date.trim();
		parsed.date = normalizedDate.toLowerCase() === DIGEST_DATE_ALL ? DIGEST_DATE_ALL : normalizedDate;
	}

	return parsed;
}

function toPositiveInt(raw: string | undefined): number | undefined {
	if (!raw) return undefined;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return undefined;
	const value = Math.floor(parsed);
	return value > 0 ? value : undefined;
}

async function cooperativeYield(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function pickLongerText(a: string | null, b: string | null): string | null {
	if (a && b) {
		return a.length >= b.length ? a : b;
	}
	return a ?? b;
}

function truncateForClassification(value: string | null): string | null {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	if (trimmed.length <= CLASSIFICATION_TEXT_MAX_CHARS) {
		return trimmed;
	}
	return trimmed.slice(0, CLASSIFICATION_TEXT_MAX_CHARS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDateStamp(value: string | undefined): value is string {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function formatLocalDateStamp(date: Date): string {
	const year = String(date.getFullYear());
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function expandAndResolvePath(rawPath: string): string {
	let expanded = rawPath.trim();
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

function extractDateStampFromPath(filePath: string): string | undefined {
	const name = parse(filePath).name;
	const lastToken = name.split(".").at(-1);
	return isDateStamp(lastToken) ? lastToken : undefined;
}

function buildDigestDraftPath(dateStamp: string): string {
	return join(DIGEST_OUTPUT_DIR, `draft.${dateStamp}.md`);
}

function buildDigestDraftJsonlPath(dateStamp: string): string {
	return join(DIGEST_OUTPUT_DIR, `draft.${dateStamp}.jsonl`);
}

function buildDigestDraftDebugPath(dateStamp: string): string {
	return join(DIGEST_OUTPUT_DIR, `draft-debug.${dateStamp}.md`);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function listArchiveDates(baseOutputPath: string): Promise<string[]> {
	const parsed = parse(baseOutputPath);
	const ext = parsed.ext || ".jsonl";
	const name = parsed.name || parsed.base || "home";
	const pattern = new RegExp(`^${escapeRegExp(name)}\\.(\\d{4}-\\d{2}-\\d{2})${escapeRegExp(ext)}$`);

	let entries: string[] = [];
	try {
		entries = await readdir(parsed.dir);
	} catch {
		return [];
	}

	const dates = entries
		.map((entry) => {
			const match = entry.match(pattern);
			return match?.[1] ?? null;
		})
		.filter((item): item is string => Boolean(item));

	return [...new Set(dates)].sort((a, b) => b.localeCompare(a));
}

async function pickArchiveDateWithUi(
	ctx: CommandContext,
	archiveDates: string[],
	todayDate: string,
): Promise<string> {
	if (!ctx.hasUI || !ctx.ui?.select || archiveDates.length === 0) {
		return todayDate;
	}

	const options = [
		`${DIGEST_DATE_ALL} (all archives)`,
		...archiveDates.map((date) => (date === todayDate ? `${date} (today)` : date)),
	];
	const selected = await ctx.ui.select("Select digest archive date", options);
	if (!selected) {
		return todayDate;
	}
	if (selected.startsWith(DIGEST_DATE_ALL)) {
		return DIGEST_DATE_ALL;
	}

	return selected.slice(0, 10);
}

function extractTweetId(tweet: Record<string, unknown>): string | null {
	return (
		readString(tweet.id) ??
		readString(tweet.id_str) ??
		readString(tweet.rest_id) ??
		(isRecord(tweet.legacy) ? readString(tweet.legacy.id_str) : null)
	);
}

function extractAuthorName(tweet: Record<string, unknown> | null): string | null {
	if (!tweet) {
		return null;
	}

	const author = isRecord(tweet.author) ? tweet.author : null;
	if (!author) {
		return null;
	}

	return readString(author.name) ?? readString(author.screen_name);
}

function extractCreatedAt(tweet: Record<string, unknown> | null): string | null {
	if (!tweet) {
		return null;
	}

	return readString(tweet.createdAt);
}

function parseCreatedAtMs(createdAt: string | null): number | null {
	if (!createdAt) {
		return null;
	}

	const time = Date.parse(createdAt);
	return Number.isFinite(time) ? time : null;
}

function compareCreatedAtAsc(a: string | null, b: string | null): number {
	const aMs = parseCreatedAtMs(a);
	const bMs = parseCreatedAtMs(b);

	if (aMs !== null && bMs !== null) {
		return aMs - bMs;
	}
	if (aMs !== null) {
		return -1;
	}
	if (bMs !== null) {
		return 1;
	}
	return 0;
}

function parseIndexNumber(indexId: string, prefix: string): number | null {
	if (!indexId.startsWith(prefix)) {
		return null;
	}

	const numberPart = Number(indexId.slice(prefix.length));
	return Number.isInteger(numberPart) && numberPart > 0 ? numberPart : null;
}

function sortIndexIds(indexIds: string[], prefix: string): string[] {
	return [...indexIds].sort((a, b) => {
		const aNum = parseIndexNumber(a, prefix);
		const bNum = parseIndexNumber(b, prefix);
		if (aNum !== null && bNum !== null) {
			return aNum - bNum;
		}
		if (aNum !== null) {
			return -1;
		}
		if (bNum !== null) {
			return 1;
		}
		return a.localeCompare(b);
	});
}

function buildClassificationPayload(tweet: Record<string, unknown>): Record<string, unknown> {
	const tweetFull = isRecord(tweet.tweetFull) ? tweet.tweetFull : null;
	const quoted = isRecord(tweet.quotedTweet) ? tweet.quotedTweet : null;
	const quotedFull = isRecord(tweet.quotedTweetFull) ? tweet.quotedTweetFull : null;

	const tweetText = readString(tweet.text);
	const tweetFullText = pickLongerText(
		pickLongerText(
			tweetFull ? readString(tweetFull.fullText) : null,
			tweetFull ? readString(tweetFull.text) : null,
		),
		tweetText,
	);
	const truncatedTweetText = truncateForClassification(tweetText);
	const truncatedTweetFullText = truncateForClassification(tweetFullText);
	const tweetMedia = Array.isArray(tweetFull?.media) ? tweetFull.media.length : 0;
	const tweetCreatedAt = extractCreatedAt(tweet) ?? extractCreatedAt(tweetFull);

	const quotedText = quoted ? readString(quoted.text) : null;
	const quotedFullText = pickLongerText(
		pickLongerText(
			quotedFull ? readString(quotedFull.fullText) : null,
			quotedFull ? readString(quotedFull.text) : null,
		),
		quotedText,
	);
	const truncatedQuotedText = truncateForClassification(quotedText);
	const truncatedQuotedFullText = truncateForClassification(quotedFullText);
	const quotedMedia = Array.isArray(quotedFull?.media) ? quotedFull.media.length : 0;
	const quotedCreatedAt = extractCreatedAt(quoted) ?? extractCreatedAt(quotedFull);

	return {
		tweet: {
			id: extractTweetId(tweet),
			text: truncatedTweetText,
			fullText: truncatedTweetFullText,
			createdAt: tweetCreatedAt,
			mediaCount: tweetMedia,
		},
		quotedTweet: quoted
			? {
					id: extractTweetId(quoted),
					text: truncatedQuotedText,
					fullText: truncatedQuotedFullText,
					createdAt: quotedCreatedAt,
					mediaCount: quotedMedia,
			  }
			: null,
	};
}

function buildScratchPayload(tweet: Record<string, unknown>): Record<string, unknown> {
	const tweetFull = isRecord(tweet.tweetFull) ? tweet.tweetFull : null;
	const quoted = isRecord(tweet.quotedTweet) ? tweet.quotedTweet : null;
	const quotedFull = isRecord(tweet.quotedTweetFull) ? tweet.quotedTweetFull : null;

	const tweetText = readString(tweet.text);
	const tweetFullText = pickLongerText(
		pickLongerText(
			tweetFull ? readString(tweetFull.fullText) : null,
			tweetFull ? readString(tweetFull.text) : null,
		),
		tweetText,
	);

	const quotedText = quoted ? readString(quoted.text) : null;
	const quotedFullText = pickLongerText(
		pickLongerText(
			quotedFull ? readString(quotedFull.fullText) : null,
			quotedFull ? readString(quotedFull.text) : null,
		),
		quotedText,
	);
	const tweetAuthorName = extractAuthorName(tweet) ?? extractAuthorName(tweetFull);
	const quotedAuthorName = extractAuthorName(quotedFull) ?? extractAuthorName(quoted);
	const tweetCreatedAt = extractCreatedAt(tweet) ?? extractCreatedAt(tweetFull);
	const quotedCreatedAt = extractCreatedAt(quoted) ?? extractCreatedAt(quotedFull);

	return {
		tweet: {
			id: extractTweetId(tweet),
			text: tweetText,
			fullText: tweetFullText,
			authorName: tweetAuthorName,
			createdAt: tweetCreatedAt,
		},
		quotedTweet: quoted
			? {
					id: extractTweetId(quoted),
					text: quotedText,
					fullText: quotedFullText,
					authorName: quotedAuthorName,
					createdAt: quotedCreatedAt,
			  }
			: null,
	};
}

function buildClassifierUserPrompt(tweet: Record<string, unknown>): string {
	const payload = buildClassificationPayload(tweet);
	return [
		"Classify this tweet into exactly one allowed category.",
		"Output strict JSON only.",
		"Tweet payload:",
		JSON.stringify(payload, null, 2),
	].join("\n");
}

function extractAssistantText(message: AssistantMessage): string {
	const textChunks = message.content
		.filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")
		.map((item) => item.text ?? "");
	const text = textChunks.join("\n").trim();
	if (text.length > 0) {
		return text;
	}

	const thinkingChunks = message.content
		.filter((item): item is Extract<typeof item, { type: "thinking" }> => item.type === "thinking")
		.map((item) => item.thinking ?? "");
	return thinkingChunks.join("\n").trim();
}

function stripCodeFence(text: string): string {
	const trimmed = text.trim();
	const matched = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	if (!matched) {
		return trimmed;
	}
	return matched[1]?.trim() ?? "";
}

function parseClassificationOutput(text: string): { category: string; confidence: number; reason: string } | null {
	const normalized = stripCodeFence(text);
	const parsed =
		tryParseClassificationJson(normalized) ??
		tryParseClassificationJson(extractJsonObject(normalized)) ??
		tryParseClassificationJson(stripCodeFence(extractJsonObject(normalized)));
	if (!parsed) {
		return null;
	}

	if (!CATEGORY_SET.has(parsed.category)) {
		return null;
	}

	const confidence = Number.isFinite(parsed.confidence)
		? Math.max(0, Math.min(1, parsed.confidence))
		: 0.5;

	return {
		category: parsed.category,
		confidence,
		reason: parsed.reason ?? "",
	};
}

function parseCategoryOnlyOutput(text: string): { category: string; confidence: number; reason: string } | null {
	const normalized = stripCodeFence(text).replace(/[：]/g, ":").trim();
	for (const category of CATEGORIES) {
		if (normalized === category) {
			return {
				category,
				confidence: 0.6,
				reason: "fallback-label",
			};
		}
	}
	return null;
}

function summarizeAssistantFailure(message: AssistantMessage, rawText: string): string {
	const stop = message.stopReason;
	const apiError = message.errorMessage?.trim();
	if (apiError) {
		return `stop=${stop}, error=${apiError.slice(0, 160)}`;
	}

	const raw = rawText.trim();
	if (raw.length > 0) {
		return `stop=${stop}, raw=${raw.slice(0, 160)}`;
	}

	return `stop=${stop}, empty-output`;
}

function extractJsonObject(text: string): string {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) {
		return "";
	}
	return text.slice(start, end + 1);
}

function tryParseClassificationJson(
	raw: string,
): { category: string; confidence: number; reason: string } | null {
	if (!raw) {
		return null;
	}
	try {
		const parsed = JSON.parse(raw);
		if (!isRecord(parsed)) {
			return null;
		}
		const category = readString(parsed.category);
		if (!category) {
			return null;
		}
		const confidenceValue =
			typeof parsed.confidence === "number"
				? parsed.confidence
				: typeof parsed.confidence === "string"
					? Number(parsed.confidence)
					: NaN;
		const reason = readString(parsed.reason) ?? "";
		return {
			category,
			confidence: Number.isFinite(confidenceValue) ? confidenceValue : 0.5,
			reason,
		};
	} catch {
		return null;
	}
}

async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	mapper: (item: T, index: number) => Promise<R>,
	onDone?: (completed: number, total: number) => void,
): Promise<R[]> {
	if (items.length === 0) {
		return [];
	}

	const workerCount = Math.max(1, Math.min(concurrency, items.length));
	const results: R[] = new Array(items.length);
	let cursor = 0;
	let completed = 0;

	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			while (true) {
				const index = cursor;
				cursor += 1;
				if (index >= items.length) {
					return;
				}
				results[index] = await mapper(items[index] as T, index);
				completed += 1;
				onDone?.(completed, items.length);
			}
		}),
	);

	return results;
}

async function parseJsonlItems(
	content: string,
	meta: { archiveFile: string; archiveOrder: number },
): Promise<ClassificationItem[]> {
	const items: ClassificationItem[] = [];
	const lines = content.split(/\r?\n/);
	let processedLinesSinceYield = 0;

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		processedLinesSinceYield += 1;
		if (processedLinesSinceYield >= CLASSIFY_COOPERATIVE_YIELD_EVERY_LINES) {
			processedLinesSinceYield = 0;
			await cooperativeYield();
		}

		const rawLine = lines[lineIndex]?.trim();
		if (!rawLine) {
			continue;
		}

		let batch: unknown;
		try {
			batch = JSON.parse(rawLine);
		} catch {
			continue;
		}
		if (!isRecord(batch)) {
			continue;
		}

		const seqValue = batch.seq;
		const batchSeq = typeof seqValue === "number" && Number.isFinite(seqValue) ? seqValue : null;
		const tweets = Array.isArray(batch.tweets) ? batch.tweets : [];
		for (let tweetIndex = 0; tweetIndex < tweets.length; tweetIndex += 1) {
			const tweet = tweets[tweetIndex];
			if (!isRecord(tweet)) {
				continue;
			}

			items.push({
				archiveFile: meta.archiveFile,
				archiveOrder: meta.archiveOrder,
				lineNumber: lineIndex + 1,
				batchSeq,
				tweetIndex,
				tweetId: extractTweetId(tweet),
				tweet,
			});
		}
	}

	return items;
}

function pickLongestText(...candidates: Array<string | null | undefined>): string {
	let best = "";
	for (const candidate of candidates) {
		if (typeof candidate !== "string") {
			continue;
		}
		const trimmed = candidate.trim();
		if (trimmed.length > best.length) {
			best = trimmed;
		}
	}
	return best;
}

function extractMainTextForDedup(tweet: Record<string, unknown>): string {
	const tweetFull = isRecord(tweet.tweetFull) ? tweet.tweetFull : null;
	return pickLongestText(
		readString(tweet.text),
		tweetFull ? readString(tweetFull.text) : null,
		tweetFull ? readString(tweetFull.fullText) : null,
	);
}

function extractQuotedTextForDedup(tweet: Record<string, unknown>): string {
	const quoted = isRecord(tweet.quotedTweet) ? tweet.quotedTweet : null;
	const quotedFull = isRecord(tweet.quotedTweetFull) ? tweet.quotedTweetFull : null;
	return pickLongestText(
		quoted ? readString(quoted.text) : null,
		quotedFull ? readString(quotedFull.text) : null,
		quotedFull ? readString(quotedFull.fullText) : null,
	);
}

function scoreItemTextLengthForDedup(item: ClassificationItem): number {
	const mainText = extractMainTextForDedup(item.tweet);
	const quotedText = extractQuotedTextForDedup(item.tweet);
	return mainText.length + quotedText.length;
}

function dedupeItemsByTweetId(items: ClassificationItem[]): {
	items: ClassificationItem[];
	beforeCount: number;
	afterCount: number;
	removedCount: number;
} {
	const byId = new Map<string, ClassificationItem>();
	const withoutId: ClassificationItem[] = [];

	for (const item of items) {
		if (!item.tweetId) {
			withoutId.push(item);
			continue;
		}

		const existing = byId.get(item.tweetId);
		if (!existing) {
			byId.set(item.tweetId, item);
			continue;
		}

		if (scoreItemTextLengthForDedup(item) > scoreItemTextLengthForDedup(existing)) {
			byId.set(item.tweetId, item);
		}
	}

	const deduped = [...byId.values(), ...withoutId];
	return {
		items: deduped,
		beforeCount: items.length,
		afterCount: deduped.length,
		removedCount: items.length - deduped.length,
	};
}

function sortItemsForScratch(items: ClassificationItem[]): ClassificationItem[] {
	return [...items].sort((a, b) => {
		if (a.archiveOrder !== b.archiveOrder) {
			return a.archiveOrder - b.archiveOrder;
		}
		if (a.lineNumber !== b.lineNumber) {
			return a.lineNumber - b.lineNumber;
		}
		if (a.tweetIndex !== b.tweetIndex) {
			return a.tweetIndex - b.tweetIndex;
		}
		const aId = a.tweetId ?? "";
		const bId = b.tweetId ?? "";
		return aId.localeCompare(bId);
	});
}

function pickRandomItems<T>(items: T[], count: number): T[] {
	if (items.length <= count) {
		return [...items];
	}

	const shuffled = [...items];
	for (let i = shuffled.length - 1; i > 0; i -= 1) {
		const j = Math.floor(Math.random() * (i + 1));
		const current = shuffled[i];
		shuffled[i] = shuffled[j] as T;
		shuffled[j] = current as T;
	}
	return shuffled.slice(0, count);
}

type ScratchNode = {
	indexId: string;
	tweetId: string | null;
	authorName: string | null;
	createdAt: string | null;
	text: string;
	referenceIndexIds: string[];
	referencedBy: string[];
	sourceKinds: string[];
	sourceRef: string | null;
	category: string | null;
	confidence: number | null;
	reason: string | null;
};

type ScratchShortLinkMapping = {
	shortUrl: string;
	resolvedUrl: string | null;
	tweetId: string | null;
};

function pickPayloadPrimaryText(part: Record<string, unknown> | null): string {
	const full = part ? readString(part.fullText) : null;
	const text = part ? readString(part.text) : null;
	return pickLongerText(full, text) ?? "";
}

function extractStatusIdFromUrl(url: string | null): string | null {
	if (!url) {
		return null;
	}

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

function isTweetMediaPermalinkUrl(url: string | null): boolean {
	if (!url) {
		return false;
	}

	const normalized = url.trim();
	if (!normalized) {
		return false;
	}

	return (
		/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status\/\d+\/(?:video|photo)\/\d+(?:[?#].*)?$/i.test(
			normalized,
		) ||
		/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/i\/web\/status\/\d+\/(?:video|photo)\/\d+(?:[?#].*)?$/i.test(
			normalized,
		)
	);
}

function toScratchShortLinkMappings(value: unknown): ScratchShortLinkMapping[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const parsed: ScratchShortLinkMapping[] = [];
	for (const item of value) {
		if (!isRecord(item)) {
			continue;
		}

		const shortUrl = readString(item.shortUrl);
		if (!shortUrl) {
			continue;
		}

		parsed.push({
			shortUrl,
			resolvedUrl: readString(item.resolvedUrl),
			tweetId: readString(item.tweetId),
		});
	}

	return parsed;
}

function rewriteShortLinksForScratch(
	text: string,
	mappings: ScratchShortLinkMapping[],
	currentTweetId: string | null,
): string {
	if (!text || mappings.length === 0) {
		return text;
	}

	let rewritten = text;
	for (const mapping of mappings) {
		const resolvedStatusId = extractStatusIdFromUrl(mapping.resolvedUrl);
		const isSelfResolvedTweet = Boolean(
			mapping.resolvedUrl && resolvedStatusId && currentTweetId && resolvedStatusId === currentTweetId,
		);
		const replacement = isSelfResolvedTweet ? "" : (mapping.resolvedUrl ?? mapping.shortUrl);
		rewritten = rewritten.split(mapping.shortUrl).join(replacement);
	}

	return rewritten.replace(/[ \t]{2,}/g, " ").replace(/ +\n/g, "\n").trim();
}

function buildScratchQuotedKey(tweetId: string | null, text: string): string {
	if (tweetId) {
		return `id:${tweetId}`;
	}
	return `text:${text.slice(0, 160)}`;
}

function pushUnique(items: string[], value: string): void {
	if (!items.includes(value)) {
		items.push(value);
	}
}

function mergeScratchNodeInPlace(target: ScratchNode, incoming: ScratchNode): void {
	for (const sourceKind of incoming.sourceKinds) {
		pushUnique(target.sourceKinds, sourceKind);
	}

	for (const ref of incoming.referenceIndexIds) {
		pushUnique(target.referenceIndexIds, ref);
	}

	for (const referencedBy of incoming.referencedBy) {
		pushUnique(target.referencedBy, referencedBy);
	}

	if (!target.authorName && incoming.authorName) {
		target.authorName = incoming.authorName;
	}

	if (!target.createdAt && incoming.createdAt) {
		target.createdAt = incoming.createdAt;
	}

	if (incoming.text.length > target.text.length) {
		target.text = incoming.text;
	}

	if (!target.sourceRef && incoming.sourceRef) {
		target.sourceRef = incoming.sourceRef;
	}

	if (!target.category && incoming.category) {
		target.category = incoming.category;
		target.confidence = incoming.confidence;
		target.reason = incoming.reason;
	}
}

function mergeScratchNodesByTweetId(nodes: ScratchNode[]): ScratchNode[] {
	const merged: ScratchNode[] = [];
	const byTweetId = new Map<string, ScratchNode>();
	const oldToCanonicalId = new Map<string, string>();

	for (const node of nodes) {
		const tweetId = node.tweetId;
		if (!tweetId) {
			merged.push({
				...node,
				sourceKinds: [...node.sourceKinds],
				referenceIndexIds: [...node.referenceIndexIds],
				referencedBy: [...node.referencedBy],
			});
			oldToCanonicalId.set(node.indexId, node.indexId);
			continue;
		}

		const existing = byTweetId.get(tweetId);
		if (!existing) {
			const cloned = {
				...node,
				sourceKinds: [...node.sourceKinds],
				referenceIndexIds: [...node.referenceIndexIds],
				referencedBy: [...node.referencedBy],
			};
			merged.push(cloned);
			byTweetId.set(tweetId, cloned);
			oldToCanonicalId.set(node.indexId, cloned.indexId);
			continue;
		}

		mergeScratchNodeInPlace(existing, node);
		oldToCanonicalId.set(node.indexId, existing.indexId);
	}

	for (const node of merged) {
		const normalizedRefs = node.referenceIndexIds
			.map((id) => oldToCanonicalId.get(id) ?? id)
			.filter((id, idx, arr) => arr.indexOf(id) === idx)
			.filter((id) => id !== node.indexId);
		node.referenceIndexIds = normalizedRefs;

		const normalizedReferencedBy = node.referencedBy
			.map((id) => oldToCanonicalId.get(id) ?? id)
			.filter((id, idx, arr) => arr.indexOf(id) === idx)
			.filter((id) => id !== node.indexId);
		node.referencedBy = normalizedReferencedBy;
	}

	return merged;
}

function buildClassificationScratchMarkdown(
	items: ClassificationItem[],
	results: ClassificationResult[],
	sourceFile: string,
): {
	markdown: string;
	jsonlLines: string[];
	keptCount: number;
	droppedCount: number;
} {
	const referencedNodesByKey = new Map<string, ScratchNode>();
	const referencedNodesInOrder: ScratchNode[] = [];
	const mainNodes: ScratchNode[] = [];
	let nextReferencedIndex = 1;
	let keptCount = 0;

	for (let index = 0; index < items.length; index += 1) {
		const item = items[index] as ClassificationItem;
		const result = results[index] as ClassificationResult | undefined;
		if (!result?.category || result.category === IRRELEVANT_CATEGORY) {
			continue;
		}

		keptCount += 1;
		const payload = buildScratchPayload(item.tweet);
		const tweetPart = isRecord(payload.tweet) ? payload.tweet : null;
		const quotedPart = isRecord(payload.quotedTweet) ? payload.quotedTweet : null;

		const mainIndexId = `M${keptCount}`;
		const mainTweetId = tweetPart ? readString(tweetPart.id) : null;
		const mainAuthorName = tweetPart ? readString(tweetPart.authorName) : null;
		const mainCreatedAt = tweetPart ? readString(tweetPart.createdAt) : null;
		const mainShortLinkMappings = toScratchShortLinkMappings(item.tweet.shortLinkMappings);
		const mainText = rewriteShortLinksForScratch(
			pickPayloadPrimaryText(tweetPart),
			mainShortLinkMappings,
			mainTweetId,
		);

		const mainNode: ScratchNode = {
			indexId: mainIndexId,
			tweetId: mainTweetId,
			authorName: mainAuthorName,
			createdAt: mainCreatedAt,
			text: mainText,
			referenceIndexIds: [],
			referencedBy: [],
			sourceKinds: ["main"],
			sourceRef: `${parse(item.archiveFile).base}:line=${item.lineNumber},tweetIndex=${item.tweetIndex}`,
			category: result.category,
			confidence: result.confidence,
			reason: result.reason || null,
		};

		if (quotedPart) {
			const quotedTweetId = readString(quotedPart.id);
			const quotedAuthorName = readString(quotedPart.authorName);
			const quotedCreatedAt = readString(quotedPart.createdAt);
			const quotedSource = isRecord(item.tweet.quotedTweetFull)
				? item.tweet.quotedTweetFull
				: isRecord(item.tweet.quotedTweet)
					? item.tweet.quotedTweet
					: null;
			const quotedShortLinkMappings = toScratchShortLinkMappings(quotedSource?.shortLinkMappings);
			const quotedText = rewriteShortLinksForScratch(
				pickPayloadPrimaryText(quotedPart),
				quotedShortLinkMappings,
				quotedTweetId,
			);
			const quotedKey = buildScratchQuotedKey(quotedTweetId, quotedText);

			let quotedNode = referencedNodesByKey.get(quotedKey);
			if (!quotedNode) {
				quotedNode = {
					indexId: `R${nextReferencedIndex}`,
					tweetId: quotedTweetId,
					authorName: quotedAuthorName,
					createdAt: quotedCreatedAt,
					text: quotedText,
					referenceIndexIds: [],
					referencedBy: [],
					sourceKinds: ["quoted"],
					sourceRef: null,
					category: null,
					confidence: null,
					reason: null,
				};
				nextReferencedIndex += 1;
				referencedNodesByKey.set(quotedKey, quotedNode);
				referencedNodesInOrder.push(quotedNode);
			}

			pushUnique(mainNode.referenceIndexIds, quotedNode.indexId);
			pushUnique(quotedNode.referencedBy, mainIndexId);
			pushUnique(quotedNode.sourceKinds, "quoted");
			if (!quotedNode.authorName && quotedAuthorName) {
				quotedNode.authorName = quotedAuthorName;
			}
			if (!quotedNode.createdAt && quotedCreatedAt) {
				quotedNode.createdAt = quotedCreatedAt;
			}
			if (quotedText.length > quotedNode.text.length) {
				quotedNode.text = quotedText;
			}
		}

		const shortLinkMappings = Array.isArray(item.tweet.shortLinkMappings) ? item.tweet.shortLinkMappings : [];
		for (const mapping of shortLinkMappings) {
			if (!isRecord(mapping)) {
				continue;
			}

			const mappingResolvedUrl = readString(mapping.resolvedUrl);
			const mappingShortUrl = readString(mapping.shortUrl);
			if (isTweetMediaPermalinkUrl(mappingResolvedUrl ?? mappingShortUrl)) {
				// Media sub-links should not become standalone non-main timeline nodes.
				continue;
			}

			const mappingTweetId = readString(mapping.tweetId);
			const mappingTweetFull = isRecord(mapping.tweetFull) ? mapping.tweetFull : null;
			const mappingAuthorName = extractAuthorName(mappingTweetFull);
			const mappingCreatedAt = extractCreatedAt(mappingTweetFull);
			const mappingShortLinkMappings = toScratchShortLinkMappings(mappingTweetFull?.shortLinkMappings);
			const mappingText = rewriteShortLinksForScratch(
				pickPayloadPrimaryText(mappingTweetFull),
				mappingShortLinkMappings,
				mappingTweetId,
			);
			if (!mappingTweetId && !mappingText) {
				continue;
			}

			const fallbackText =
				mappingText || readString(mapping.resolvedUrl) || readString(mapping.shortUrl) || "(no text)";
			const mappingKey = buildScratchQuotedKey(mappingTweetId, fallbackText);

			let mappingNode = referencedNodesByKey.get(mappingKey);
			if (!mappingNode) {
				mappingNode = {
					indexId: `R${nextReferencedIndex}`,
					tweetId: mappingTweetId,
					authorName: mappingAuthorName,
					createdAt: mappingCreatedAt,
					text: fallbackText,
					referenceIndexIds: [],
					referencedBy: [],
					sourceKinds: ["shortLink"],
					sourceRef: null,
					category: null,
					confidence: null,
					reason: null,
				};
				nextReferencedIndex += 1;
				referencedNodesByKey.set(mappingKey, mappingNode);
				referencedNodesInOrder.push(mappingNode);
			}

			pushUnique(mainNode.referenceIndexIds, mappingNode.indexId);
			pushUnique(mappingNode.referencedBy, mainIndexId);
			pushUnique(mappingNode.sourceKinds, "shortLink");
			if (!mappingNode.authorName && mappingAuthorName) {
				mappingNode.authorName = mappingAuthorName;
			}
			if (!mappingNode.createdAt && mappingCreatedAt) {
				mappingNode.createdAt = mappingCreatedAt;
			}
			if (fallbackText.length > mappingNode.text.length) {
				mappingNode.text = fallbackText;
			}
		}

		mainNodes.push(mainNode);
	}

	const droppedCount = items.length - keptCount;
	const mergedNodes = mergeScratchNodesByTweetId([...referencedNodesInOrder, ...mainNodes]);
	const sortedNodes = mergedNodes.sort((a, b) => {
		const byTime = compareCreatedAtAsc(a.createdAt, b.createdAt);
		if (byTime !== 0) {
			return byTime;
		}

		const aIsMain = a.sourceKinds.includes("main");
		const bIsMain = b.sourceKinds.includes("main");
		if (aIsMain !== bIsMain) {
			return aIsMain ? 1 : -1;
		}

		return a.indexId.localeCompare(b.indexId);
	});

	const nodeIdRemap = new Map<string, string>();
	for (let index = 0; index < sortedNodes.length; index += 1) {
		const node = sortedNodes[index] as ScratchNode;
		nodeIdRemap.set(node.indexId, `N${index + 1}`);
	}

	const remappedNodes = sortedNodes.map((node) => ({
		...node,
		indexId: nodeIdRemap.get(node.indexId) ?? node.indexId,
		referenceIndexIds: sortIndexIds(
			node.referenceIndexIds
				.map((id) => nodeIdRemap.get(id) ?? id)
				.filter((id) => id !== (nodeIdRemap.get(node.indexId) ?? node.indexId)),
			"N",
		),
		referencedBy: sortIndexIds(
			node.referencedBy
				.map((id) => nodeIdRemap.get(id) ?? id)
				.filter((id) => id !== (nodeIdRemap.get(node.indexId) ?? node.indexId)),
			"N",
		),
	}));

	const jsonlLines = remappedNodes.map((node) =>
		JSON.stringify({
			indexId: node.indexId,
			tweetId: node.tweetId,
			authorName: node.authorName,
			createdAt: node.createdAt,
			sourceKinds: node.sourceKinds,
			category: node.category,
			confidence: node.confidence,
			reason: node.reason,
			refs: node.referenceIndexIds,
			referencedBy: node.referencedBy,
			sourceRef: node.sourceRef,
			text: node.text,
		}),
	);

	const lines: string[] = [];
	lines.push("# Digest Draft");
	lines.push("");
	lines.push(`- generatedAt: ${new Date().toISOString()}`);
	lines.push(`- source: ${sourceFile}`);
	lines.push(`- totalTweets: ${items.length}`);
	lines.push(`- keptTweets: ${keptCount}`);
	lines.push(`- droppedIrrelevant: ${droppedCount}`);
	lines.push("");
	lines.push("## Tweets (Chronological)");
	lines.push("");

	if (remappedNodes.length === 0) {
		lines.push("- (none)");
		lines.push("");
	} else {
		for (const node of remappedNodes) {
			const refs = node.referenceIndexIds.join(", ");
			const referencedBy = node.referencedBy.join(", ");
			const sourceKinds = node.sourceKinds.join("+");
			const confidence = typeof node.confidence === "number" ? node.confidence.toFixed(2) : "n/a";
			lines.push(
				`### [${node.indexId}] id=${node.tweetId ?? "n/a"} author=${node.authorName ?? "n/a"} createdAt=${node.createdAt ?? "n/a"} source=${sourceKinds || "unknown"} category=${node.category ?? "n/a"} confidence=${confidence} reason=${node.reason ?? ""} refs=${refs || "none"} referencedBy=${referencedBy || "none"} sourceRef=${node.sourceRef ?? "n/a"}`,
			);
			lines.push("```text");
			lines.push(node.text || "(no text)");
			lines.push("```");
			lines.push("");
		}
	}

	return {
		markdown: lines.join("\n"),
		jsonlLines,
		keptCount,
		droppedCount,
	};
}

function buildClassificationResultMarkdown(
	items: ClassificationItem[],
	results: ClassificationResult[],
	meta: { sourceFile: string; modelLabel: string; elapsedMs: number },
): string {
	const lines: string[] = [];
	lines.push("# Digest Draft Classification Result");
	lines.push("");
	lines.push(`- generatedAt: ${new Date().toISOString()}`);
	lines.push(`- source: ${meta.sourceFile}`);
	lines.push(`- model: ${meta.modelLabel}`);
	lines.push(`- elapsedMs: ${meta.elapsedMs}`);
	lines.push(`- total: ${results.length}`);
	lines.push("");

	for (let index = 0; index < results.length; index += 1) {
		const result = results[index] as ClassificationResult;
		const item = items[index] as ClassificationItem;
		const preview = getTweetPreview(item.tweet);
		lines.push(
			`## [${index + 1}] id=${result.tweetId ?? "n/a"} category=${result.category ?? "n/a"} confidence=${result.confidence.toFixed(2)}`,
		);
		lines.push(`- reason: ${result.reason || ""}`);
		if (result.error) {
			lines.push(`- error: ${result.error}`);
		}
		lines.push(`- source: ${parse(item.archiveFile).base}:line=${item.lineNumber},tweetIndex=${item.tweetIndex}`);
		lines.push("```text");
		lines.push(preview || "(no text)");
		lines.push("```");
		lines.push("");
	}

	return lines.join("\n");
}

function toIrrelevantResult(
	item: ClassificationItem,
	classifiedAt: string,
	model: { provider: string; id: string },
	error: string,
	reason = "fallback-unrelated",
): ClassificationResult {
	return {
		lineNumber: item.lineNumber,
		batchSeq: item.batchSeq,
		tweetIndex: item.tweetIndex,
		tweetId: item.tweetId,
		category: IRRELEVANT_CATEGORY,
		confidence: 0.35,
		reason,
		error,
		model,
		classifiedAt,
	};
}

function compactText(value: string | null, maxLength = 72): string {
	if (!value) {
		return "(no text)";
	}
	const oneLine = value.replace(/\s+/g, " ").trim();
	if (oneLine.length <= maxLength) {
		return oneLine;
	}
	return `${oneLine.slice(0, maxLength - 1)}…`;
}

function getTweetPreview(tweet: Record<string, unknown>): string {
	const payload = buildClassificationPayload(tweet);
	const tweetPart = isRecord(payload.tweet) ? payload.tweet : null;
	const fullText = tweetPart ? readString(tweetPart.fullText) : null;
	const text = tweetPart ? readString(tweetPart.text) : null;
	return compactText(fullText ?? text);
}

function emitDebugResults(ctx: CommandContext, items: ClassificationItem[], results: ClassificationResult[]): void {
	for (let index = 0; index < results.length; index += 1) {
		const result = results[index] as ClassificationResult;
		const item = items[index] as ClassificationItem;
		const preview = getTweetPreview(item.tweet);
		const label = result.category ?? "分类失败";
		const confidence = result.confidence.toFixed(2);
		const reason = compactText(result.reason || result.error || "", 48);
		const text = `[${index + 1}] ${label} (${confidence}) id=${result.tweetId ?? "n/a"} | ${reason} | ${preview}`;
		notify(ctx, text, result.category ? "info" : "warning");
	}
}

function summarizeByCategory(results: ClassificationResult[]): string {
	const counts = new Map<string, number>();
	let failed = 0;

	for (const result of results) {
		if (!result.category) {
			failed += 1;
			continue;
		}
		counts.set(result.category, (counts.get(result.category) ?? 0) + 1);
	}

	const categorySummary = CATEGORIES.map((category) => `${category}:${counts.get(category) ?? 0}`).join(" ");
	return `classified=${results.length - failed} failed=${failed} ${categorySummary}`;
}

function estimateTextTokens(text: string): number {
	const normalized = text.trim();
	if (!normalized) {
		return 0;
	}
	// Approximation for mixed CN/EN content used by cost debug metrics.
	return Math.max(1, Math.ceil(Buffer.byteLength(normalized, "utf8") / 3));
}

function pickPrimaryText(part: Record<string, unknown> | null): string | null {
	if (!part) {
		return null;
	}
	return readString(part.fullText) ?? readString(part.text);
}

function estimateTweetFocusTokens(tweet: Record<string, unknown>): number {
	const payload = buildClassificationPayload(tweet);
	const tweetPart = isRecord(payload.tweet) ? payload.tweet : null;
	const quotedPart = isRecord(payload.quotedTweet) ? payload.quotedTweet : null;

	const mainText = pickPrimaryText(tweetPart);
	const quotedText = pickPrimaryText(quotedPart);

	return estimateTextTokens(mainText ?? "") + estimateTextTokens(quotedText ?? "");
}

function summarizeFocusTokenStats(items: ClassificationItem[], results: ClassificationResult[]): {
	focusTweetCount: number;
	focusTextTokens: number;
} {
	let focusTweetCount = 0;
	let focusTextTokens = 0;

	for (let index = 0; index < results.length; index += 1) {
		const result = results[index];
		const item = items[index];
		if (!result || !item) {
			continue;
		}
		if (!result.category || !FOCUS_CATEGORY_SET.has(result.category)) {
			continue;
		}
		focusTweetCount += 1;
		focusTextTokens += estimateTweetFocusTokens(item.tweet);
	}

	return { focusTweetCount, focusTextTokens };
}

function notify(ctx: CommandContext, message: string, level: NotifyLevel): void {
	publishSystemEvent({
		source: "digest",
		level,
		message,
		toast: false,
		ctx,
	});

	if (ctx.hasUI && ctx.ui?.notify) {
		ctx.ui.notify(message, level);
		return;
	}

	const prefix = level === "error" ? "[error]" : level === "warning" ? "[warn]" : "[info]";
	console.log(`${prefix} ${message}`);
}

function notifyModelCallErrorToast(
	ctx: CommandContext,
	provider: string,
	modelId: string,
	errorMessage: string,
): void {
	const normalized = errorMessage.trim() || "unknown error";
	publishSystemEvent({
		source: "digest",
		level: "error",
		message: `Draft model call failed (${provider}/${modelId}): ${normalized}`,
		dedupeKey: `digest|draft_model_call_failed|${provider}/${modelId}|${normalized.slice(0, 120)}`,
		// Keep error card overlay only; avoid duplicated ui.notify text line.
		toast: false,
		ctx,
	});
}

function isProviderCallErrorMessage(message: AssistantMessage): boolean {
	return message.stopReason === "error" || Boolean(message.errorMessage?.trim());
}

async function runDigestDraftTask(
	parsed: ParsedArgs,
	ctx: CommandContext,
	twitterConfig: ReturnType<typeof extractTwitterCollectorConfig>,
	digestConfig: ReturnType<typeof extractDigestConfig>,
): Promise<void> {
	const todayDate = formatLocalDateStamp(new Date());
	let dateSelector = parsed.date ?? todayDate;
	let archiveDates: string[] = [];
	if (!parsed.file) {
		archiveDates = await listArchiveDates(twitterConfig.outputPath);
		if (!parsed.date) {
			dateSelector = await pickArchiveDateWithUi(ctx, archiveDates, todayDate);
		}
	}

	const sourceFiles = parsed.file
		? [expandAndResolvePath(parsed.file)]
		: dateSelector === DIGEST_DATE_ALL
			? [...archiveDates]
				.sort((a, b) => a.localeCompare(b))
				.map((date) => buildDailyArchivePath(twitterConfig.outputPath, date))
			: [buildDailyArchivePath(twitterConfig.outputPath, dateSelector)];

	if (sourceFiles.length === 0) {
		notify(ctx, "No digest archive files found for --date all.", "warning");
		return;
	}

	const outputDateStamp =
		parsed.date ?? (!parsed.file ? dateSelector : undefined) ?? extractDateStampFromPath(sourceFiles[0] ?? "") ?? todayDate;
	const digestDraftPath = buildDigestDraftPath(outputDateStamp);
	const digestDraftJsonlPath = buildDigestDraftJsonlPath(outputDateStamp);
	const digestDraftDebugPath = buildDigestDraftDebugPath(outputDateStamp);
	const sourceLabel =
		sourceFiles.length === 1
			? (sourceFiles[0] as string)
			: `${sourceFiles.length} files (${DIGEST_DATE_ALL} archives)`;

	const parsedItems: ClassificationItem[] = [];
	for (let archiveOrder = 0; archiveOrder < sourceFiles.length; archiveOrder += 1) {
		const sourceFile = sourceFiles[archiveOrder] as string;
		let sourceRaw: string;
		try {
			sourceRaw = await readFile(sourceFile, "utf-8");
		} catch (error) {
			const message = `Unable to read archive file: ${sourceFile} (${error instanceof Error ? error.message : String(error)})`;
			if (sourceFiles.length === 1) {
				notify(ctx, message, "error");
				return;
			}
			notify(ctx, `${message}; skipped.`, "warning");
			continue;
		}

		const batchItems = await parseJsonlItems(sourceRaw, {
			archiveFile: sourceFile,
			archiveOrder,
		});
		parsedItems.push(...batchItems);
	}

	if (parsedItems.length === 0) {
		notify(ctx, `No tweets found in ${sourceLabel}.`, "warning");
		return;
	}

	const deduped = dedupeItemsByTweetId(parsedItems);
	notify(
		ctx,
		`Digest dedupe done: before=${deduped.beforeCount} after=${deduped.afterCount} removed=${deduped.removedCount}.`,
		"info",
	);

	const items = sortItemsForScratch(deduped.items);

	if (!ENABLE_CLASSIFICATION_BRANCH) {
		notify(
			ctx,
			"Digest draft branch is disabled; exported sorted single-day cumulative archive to draft only.",
			"info",
		);
		return;
	}

	const provider = parsed.provider ?? digestConfig.classifier.provider;
	const modelId = parsed.model ?? digestConfig.classifier.model;
	if (!provider || !modelId) {
		notify(
			ctx,
			"Missing digest classifier model. Set digest.classifier.provider/model in ~/.mono-pilot/config.json or pass --provider/--model.",
			"warning",
		);
		return;
	}

	const model = ctx.modelRegistry.find(provider, modelId);
	if (!model) {
		notify(ctx, `Model not found: ${provider}/${modelId}.`, "error");
		return;
	}

	const apiKey = await ctx.modelRegistry.getApiKey(model);
	if (!apiKey) {
		notify(ctx, `No API key for model provider: ${provider}.`, "error");
		return;
	}

	const concurrency = parsed.concurrency ?? digestConfig.classifier.concurrency;
	const maxTokens = digestConfig.classifier.maxTokens;

	notify(
		ctx,
		`Digest draft start: full ${items.length} tweets from ${sourceLabel}, model=${provider}/${modelId}, concurrency=${concurrency}.`,
		"info",
	);

	const startedAt = Date.now();
	let lastProgressAt = 0;

	const results = await mapWithConcurrency(
		items,
		concurrency,
		async (item) => {
			const classifiedAt = new Date().toISOString();
			const prompt = buildClassifierUserPrompt(item.tweet);
			try {
				const assistant = await completeSimple(
					model,
					{
						systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
						messages: [
							{
								role: "user",
								content: [{ type: "text", text: prompt }],
								timestamp: Date.now(),
							},
						],
					},
					{ apiKey, maxTokens },
				);

				const rawText = extractAssistantText(assistant);
				const parsedOutput = parseClassificationOutput(rawText);
				if (parsedOutput) {
					return {
						lineNumber: item.lineNumber,
						batchSeq: item.batchSeq,
						tweetIndex: item.tweetIndex,
						tweetId: item.tweetId,
						category: parsedOutput.category,
						confidence: parsedOutput.confidence,
						reason: parsedOutput.reason,
						model: { provider: model.provider, id: model.id },
						classifiedAt,
					} satisfies ClassificationResult;
				}

				const fallbackAssistant = await completeSimple(
					model,
					{
						systemPrompt: CLASSIFIER_LABEL_FALLBACK_PROMPT,
						messages: [
							{
								role: "user",
								content: [{ type: "text", text: prompt }],
								timestamp: Date.now(),
							},
						],
					},
					{ apiKey, maxTokens: 64 },
				);

				const fallbackRawText = extractAssistantText(fallbackAssistant);
				const fallbackParsed = parseCategoryOnlyOutput(fallbackRawText);
				if (fallbackParsed) {
					return {
						lineNumber: item.lineNumber,
						batchSeq: item.batchSeq,
						tweetIndex: item.tweetIndex,
						tweetId: item.tweetId,
						category: fallbackParsed.category,
						confidence: fallbackParsed.confidence,
						reason: fallbackParsed.reason,
						model: { provider: model.provider, id: model.id },
						classifiedAt,
					} satisfies ClassificationResult;
				}

				if (isProviderCallErrorMessage(assistant) || isProviderCallErrorMessage(fallbackAssistant)) {
					notifyModelCallErrorToast(
						ctx,
						model.provider,
						model.id,
						`main=${summarizeAssistantFailure(assistant, rawText)}; fallback=${summarizeAssistantFailure(
							fallbackAssistant,
							fallbackRawText,
						)}`,
					);
				}

				return toIrrelevantResult(
					item,
					classifiedAt,
					{ provider: model.provider, id: model.id },
					`invalid classifier output (${summarizeAssistantFailure(assistant, rawText)}; fallback=${summarizeAssistantFailure(fallbackAssistant, fallbackRawText)})`,
				);
			} catch (error) {
				notifyModelCallErrorToast(
					ctx,
					model.provider,
					model.id,
					error instanceof Error ? error.message : String(error),
				);
				return toIrrelevantResult(
					item,
					classifiedAt,
					{ provider: model.provider, id: model.id },
					error instanceof Error ? error.message : String(error),
					"model-error-unrelated",
				);
			}
		},
		(completed, total) => {
			const now = Date.now();
			if (completed === total || now - lastProgressAt >= 3_000) {
				lastProgressAt = now;
				notify(ctx, `Digest draft progress: ${completed}/${total}`, "info");
			}
		},
	);

	const elapsedMs = Date.now() - startedAt;
	const scratch = buildClassificationScratchMarkdown(items, results, sourceLabel);
	await mkdir(dirname(digestDraftPath), { recursive: true });

	try {
		await writeFile(digestDraftPath, scratch.markdown, "utf-8");
		notify(
			ctx,
			`Digest draft updated: ${digestDraftPath} (kept=${scratch.keptCount}, droppedIrrelevant=${scratch.droppedCount})`,
			"info",
		);
	} catch (error) {
		notify(
			ctx,
			`Digest draft write failed: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
	}

	try {
		const jsonlRaw = scratch.jsonlLines.join("\n");
		await writeFile(digestDraftJsonlPath, jsonlRaw ? `${jsonlRaw}\n` : "", "utf-8");
		notify(ctx, `Digest draft JSONL written: ${digestDraftJsonlPath} (rows=${scratch.jsonlLines.length})`, "info");
	} catch (error) {
		notify(
			ctx,
			`Digest draft JSONL write failed: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
	}

	try {
		const classifyMarkdown = buildClassificationResultMarkdown(items, results, {
			sourceFile: sourceLabel,
			modelLabel: `${model.provider}/${model.id}`,
			elapsedMs,
		});
		await mkdir(dirname(digestDraftDebugPath), { recursive: true });
		await writeFile(digestDraftDebugPath, classifyMarkdown, "utf-8");
		notify(ctx, `Digest draft debug written: ${digestDraftDebugPath}`, "info");
	} catch (error) {
		notify(
			ctx,
			`Digest draft debug write failed: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
	}

	emitDebugResults(ctx, items, results);
	const focusStats = summarizeFocusTokenStats(items, results);
	notify(
		ctx,
		`Digest draft debug done (${elapsedMs}ms). ${summarizeByCategory(results)}. focusTweets=${focusStats.focusTweetCount} focusTextTokens=${focusStats.focusTextTokens} (estimated).`,
		"info",
	);
}

export function registerDigestCommand(pi: ExtensionAPI): void {
	pi.registerCommand("digest", {
		description: "Digest commands: draft/backfill twitter archive",
		handler: async (args, ctx) => {
			const parsed = parseArgs(args);
			if (parsed.error) {
				notify(ctx as CommandContext, parsed.error, "warning");
				return;
			}

			if (parsed.subcommand !== "draft" && parsed.subcommand !== "backfill") {
				notify(ctx as CommandContext, USAGE, "warning");
				return;
			}

			if (parsed.date && parsed.date !== DIGEST_DATE_ALL && !isDateStamp(parsed.date)) {
				notify(
					ctx as CommandContext,
					`Invalid --date: ${parsed.date}. Expected YYYY-MM-DD or ${DIGEST_DATE_ALL}.`,
					"warning",
				);
				return;
			}

			let config: Record<string, unknown>;
			try {
				config = await loadMonoPilotConfigObject();
			} catch (error) {
				notify(ctx as CommandContext, `Failed to load config: ${String(error)}`, "error");
				return;
			}

			const twitterConfig = extractTwitterCollectorConfig(config);
			const digestConfig = extractDigestConfig(config);

			if (parsed.subcommand === "backfill") {
				if (digestBackfillRunning) {
					notify(ctx as CommandContext, "Digest backfill is already running.", "warning");
					return;
				}

				digestBackfillRunning = true;
				notify(
					ctx as CommandContext,
					"Digest backfill started in background (serial). Check /events for progress.",
					"info",
				);

				void runDigestBackfill({
					twitterConfig,
					date: parsed.date,
					file: parsed.file,
					notify: (message, level) => notify(ctx as CommandContext, message, level),
				})
					.catch((error) => {
						notify(
							ctx as CommandContext,
							`Digest backfill crashed: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
					})
					.finally(() => {
						digestBackfillRunning = false;
					});
				return;
			}

			if (digestDraftRunning) {
				notify(ctx as CommandContext, "Digest draft is already running.", "warning");
				return;
			}

			digestDraftRunning = true;
			notify(
				ctx as CommandContext,
				"Digest draft started in background. Check /events for progress.",
				"info",
			);

			void runDigestDraftTask(parsed, ctx as CommandContext, twitterConfig, digestConfig)
				.catch((error) => {
					notify(
						ctx as CommandContext,
						`Digest draft crashed: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				})
				.finally(() => {
					digestDraftRunning = false;
				});
			return;
		},
	});
}
