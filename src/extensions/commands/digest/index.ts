import { completeSimple, type Api, type AssistantMessage, type Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { extractDigestConfig } from "../../../config/digest.js";
import { loadMonoPilotConfigObject } from "../../../config/mono-pilot.js";
import { extractTwitterCollectorConfig } from "../../../config/twitter.js";
import { publishSystemEvent } from "../../system-events.js";
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
	subcommand: "classify" | "backfill";
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
const CLASSIFICATION_TEXT_MAX_CHARS = 1024;
const DIGEST_SCRATCH_PATH = join(homedir(), ".mono-pilot", "twitter", "scratch.md");
const DIGEST_CLASSIFY_PATH = join(homedir(), ".mono-pilot", "twitter", "classify.md");
const ENABLE_CLASSIFICATION_BRANCH = true;
let digestBackfillRunning = false;
let digestClassifyRunning = false;
const CLASSIFY_COOPERATIVE_YIELD_EVERY_LINES = 20;

const USAGE = [
	"Usage:",
	"  /digest classify [--date YYYY-MM-DD] [--file <path>]",
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
		return { subcommand: "classify" };
	}

	let cursor = 0;
	const first = tokens[0];
	let subcommand: "classify" | "backfill" = "classify";
	if (first && !first.startsWith("--")) {
		if (first !== "classify" && first !== "backfill") {
			return { subcommand: "classify", error: `Unknown subcommand: ${first}.\n${USAGE}` };
		}
		subcommand = first;
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

		return { subcommand: "classify", error: `Unknown argument: ${token}.\n${USAGE}` };
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

	const options = archiveDates.map((date) => (date === todayDate ? `${date} (today)` : date));
	const selected = await ctx.ui.select("Select digest archive date", options);
	if (!selected) {
		return todayDate;
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

	return {
		tweet: {
			id: extractTweetId(tweet),
			text: truncatedTweetText,
			fullText: truncatedTweetFullText,
			mediaCount: tweetMedia,
		},
		quotedTweet: quoted
			? {
					id: extractTweetId(quoted),
					text: truncatedQuotedText,
					fullText: truncatedQuotedFullText,
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

	return {
		tweet: {
			id: extractTweetId(tweet),
			text: tweetText,
			fullText: tweetFullText,
		},
		quotedTweet: quoted
			? {
					id: extractTweetId(quoted),
					text: quotedText,
					fullText: quotedFullText,
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

type ScratchQuotedNode = {
	indexId: string;
	tweetId: string | null;
	text: string;
	referencedBy: string[];
	sourceKinds: string[];
};

type ScratchMainNode = {
	indexId: string;
	tweetId: string | null;
	text: string;
	referenceIndexIds: string[];
	sourceRef: string;
	category: string;
	confidence: number;
	reason: string;
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

function buildClassificationScratchMarkdown(
	items: ClassificationItem[],
	results: ClassificationResult[],
	sourceFile: string,
): { markdown: string; keptCount: number; droppedCount: number } {
	const quotedNodesByKey = new Map<string, ScratchQuotedNode>();
	const quotedNodesInOrder: ScratchQuotedNode[] = [];
	const mainNodes: ScratchMainNode[] = [];
	let nextQuotedIndex = 1;
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

		const mainIndexId = `T${keptCount}`;
		const mainTweetId = tweetPart ? readString(tweetPart.id) : null;
		const mainShortLinkMappings = toScratchShortLinkMappings(item.tweet.shortLinkMappings);
		const mainText = rewriteShortLinksForScratch(
			pickPayloadPrimaryText(tweetPart),
			mainShortLinkMappings,
			mainTweetId,
		);

		const referenceIndexIds: string[] = [];
		if (quotedPart) {
			const quotedTweetId = readString(quotedPart.id);
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

			let quotedNode = quotedNodesByKey.get(quotedKey);
			if (!quotedNode) {
				quotedNode = {
					indexId: `Q${nextQuotedIndex}`,
					tweetId: quotedTweetId,
					text: quotedText,
					referencedBy: [],
					sourceKinds: ["quoted"],
				};
				nextQuotedIndex += 1;
				quotedNodesByKey.set(quotedKey, quotedNode);
				quotedNodesInOrder.push(quotedNode);
			}

			pushUnique(referenceIndexIds, quotedNode.indexId);
			pushUnique(quotedNode.referencedBy, mainIndexId);
			pushUnique(quotedNode.sourceKinds, "quoted");
		}

		const shortLinkMappings = Array.isArray(item.tweet.shortLinkMappings) ? item.tweet.shortLinkMappings : [];
		for (const mapping of shortLinkMappings) {
			if (!isRecord(mapping)) {
				continue;
			}

			const mappingTweetId = readString(mapping.tweetId);
			const mappingTweetFull = isRecord(mapping.tweetFull) ? mapping.tweetFull : null;
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

			let mappingNode = quotedNodesByKey.get(mappingKey);
			if (!mappingNode) {
				mappingNode = {
					indexId: `Q${nextQuotedIndex}`,
					tweetId: mappingTweetId,
					text: fallbackText,
					referencedBy: [],
					sourceKinds: ["shortLink"],
				};
				nextQuotedIndex += 1;
				quotedNodesByKey.set(mappingKey, mappingNode);
				quotedNodesInOrder.push(mappingNode);
			}

			pushUnique(referenceIndexIds, mappingNode.indexId);
			pushUnique(mappingNode.referencedBy, mainIndexId);
			pushUnique(mappingNode.sourceKinds, "shortLink");
		}

		mainNodes.push({
			indexId: mainIndexId,
			tweetId: mainTweetId,
			text: mainText,
			referenceIndexIds,
			sourceRef: `${parse(item.archiveFile).base}:line=${item.lineNumber},tweetIndex=${item.tweetIndex}`,
			category: result.category,
			confidence: result.confidence,
			reason: result.reason,
		});
	}

	const droppedCount = items.length - keptCount;

	const lines: string[] = [];
	lines.push("# Digest Classify Scratch");
	lines.push("");
	lines.push(`- generatedAt: ${new Date().toISOString()}`);
	lines.push(`- source: ${sourceFile}`);
	lines.push(`- totalTweets: ${items.length}`);
	lines.push(`- keptTweets: ${keptCount}`);
	lines.push(`- droppedIrrelevant: ${droppedCount}`);
	lines.push("");
	lines.push("## Referenced Tweets (Before Referencing Tweets)");
	lines.push("");

	if (quotedNodesInOrder.length === 0) {
		lines.push("- (none)");
		lines.push("");
	} else {
		for (const quotedNode of quotedNodesInOrder) {
			const refs = quotedNode.referencedBy.join(", ");
			const sourceKinds = quotedNode.sourceKinds.join("+");
			lines.push(
				`### [${quotedNode.indexId}] id=${quotedNode.tweetId ?? "n/a"} source=${sourceKinds || "unknown"} referencedBy=${refs || "none"}`,
			);
			lines.push("```text");
			lines.push(quotedNode.text || "(no text)");
			lines.push("```");
			lines.push("");
		}
	}

	lines.push("## Referencing Tweets (After Quoted Tweets)");
	lines.push("");
	if (mainNodes.length === 0) {
		lines.push("- (none)");
		lines.push("");
	}
	for (const mainNode of mainNodes) {
		const refs = mainNode.referenceIndexIds.length > 0 ? mainNode.referenceIndexIds.join(",") : "none";
		lines.push(
			`### [${mainNode.indexId}] id=${mainNode.tweetId ?? "n/a"} category=${mainNode.category} confidence=${mainNode.confidence.toFixed(2)} reason=${mainNode.reason || ""} refs=${refs} source=${mainNode.sourceRef}`,
		);
		lines.push("```text");
		lines.push(mainNode.text || "(no text)");
		lines.push("```");
		lines.push("");
	}

	return {
		markdown: lines.join("\n"),
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
	lines.push("# Digest Classify Result");
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

async function runDigestClassifyTask(
	parsed: ParsedArgs,
	ctx: CommandContext,
	twitterConfig: ReturnType<typeof extractTwitterCollectorConfig>,
	digestConfig: ReturnType<typeof extractDigestConfig>,
): Promise<void> {
	const todayDate = formatLocalDateStamp(new Date());
	let dateStamp = parsed.date ?? todayDate;
	if (!parsed.file && !parsed.date) {
		const archiveDates = await listArchiveDates(twitterConfig.outputPath);
		dateStamp = await pickArchiveDateWithUi(ctx, archiveDates, todayDate);
	}
	const sourceFile = parsed.file
		? expandAndResolvePath(parsed.file)
		: buildDailyArchivePath(twitterConfig.outputPath, dateStamp);

	let sourceRaw: string;
	try {
		sourceRaw = await readFile(sourceFile, "utf-8");
	} catch (error) {
		notify(
			ctx,
			`Unable to read archive file: ${sourceFile} (${error instanceof Error ? error.message : String(error)})`,
			"error",
		);
		return;
	}

	const parsedItems = await parseJsonlItems(sourceRaw, {
		archiveFile: sourceFile,
		archiveOrder: 0,
	});
	if (parsedItems.length === 0) {
		notify(ctx, `No tweets found in ${sourceFile}.`, "warning");
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
			"Digest classify branch is disabled; exported sorted single-day cumulative archive to scratch only.",
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
		`Digest classify start: full ${items.length} tweets from ${sourceFile}, model=${provider}/${modelId}, concurrency=${concurrency}.`,
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

				return toIrrelevantResult(
					item,
					classifiedAt,
					{ provider: model.provider, id: model.id },
					`invalid classifier output (${summarizeAssistantFailure(assistant, rawText)}; fallback=${summarizeAssistantFailure(fallbackAssistant, fallbackRawText)})`,
				);
			} catch (error) {
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
				notify(ctx, `Digest classify progress: ${completed}/${total}`, "info");
			}
		},
	);

	const elapsedMs = Date.now() - startedAt;
	try {
		const scratch = buildClassificationScratchMarkdown(items, results, sourceFile);
		await mkdir(dirname(DIGEST_SCRATCH_PATH), { recursive: true });
		await writeFile(DIGEST_SCRATCH_PATH, scratch.markdown, "utf-8");
		notify(
			ctx,
			`Digest scratch updated: ${DIGEST_SCRATCH_PATH} (kept=${scratch.keptCount}, droppedIrrelevant=${scratch.droppedCount})`,
			"info",
		);
	} catch (error) {
		notify(
			ctx,
			`Digest scratch write failed: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
	}

	try {
		const classifyMarkdown = buildClassificationResultMarkdown(items, results, {
			sourceFile,
			modelLabel: `${model.provider}/${model.id}`,
			elapsedMs,
		});
		await mkdir(dirname(DIGEST_CLASSIFY_PATH), { recursive: true });
		await writeFile(DIGEST_CLASSIFY_PATH, classifyMarkdown, "utf-8");
		notify(ctx, `Digest classify debug written: ${DIGEST_CLASSIFY_PATH}`, "info");
	} catch (error) {
		notify(
			ctx,
			`Digest classify debug write failed: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
	}

	emitDebugResults(ctx, items, results);
	const focusStats = summarizeFocusTokenStats(items, results);
	notify(
		ctx,
		`Digest classify debug done (${elapsedMs}ms). ${summarizeByCategory(results)}. focusTweets=${focusStats.focusTweetCount} focusTextTokens=${focusStats.focusTextTokens} (estimated).`,
		"info",
	);
}

export function registerDigestCommand(pi: ExtensionAPI): void {
	pi.registerCommand("digest", {
		description: "Digest commands: classify/backfill twitter archive",
		handler: async (args, ctx) => {
			const parsed = parseArgs(args);
			if (parsed.error) {
				notify(ctx as CommandContext, parsed.error, "warning");
				return;
			}

			if (parsed.subcommand !== "classify" && parsed.subcommand !== "backfill") {
				notify(ctx as CommandContext, USAGE, "warning");
				return;
			}

			if (parsed.date && !isDateStamp(parsed.date)) {
				notify(ctx as CommandContext, `Invalid --date: ${parsed.date}. Expected YYYY-MM-DD.`, "warning");
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

			if (digestClassifyRunning) {
				notify(ctx as CommandContext, "Digest classify is already running.", "warning");
				return;
			}

			digestClassifyRunning = true;
			notify(
				ctx as CommandContext,
				"Digest classify started in background. Check /events for progress.",
				"info",
			);

			void runDigestClassifyTask(parsed, ctx as CommandContext, twitterConfig, digestConfig)
				.catch((error) => {
					notify(
						ctx as CommandContext,
						`Digest classify crashed: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				})
				.finally(() => {
					digestClassifyRunning = false;
				});
			return;
		},
	});
}
