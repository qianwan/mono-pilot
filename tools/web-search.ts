import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	formatSize,
	keyHint,
	truncateTail,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";

const DESCRIPTION = "Search web for real-time info on any topic; use for up-to-date facts not in training data, like current events or tech updates. Results include snippets and URLs.";

const PROVIDER_NAME = "Brave Search API";
const BRAVE_SEARCH_API_URL = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_SEARCH_API_KEY_ENV = "BRAVE_SEARCH_API_KEY";
const REQUEST_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_RESULT_COUNT = 8;
const MAX_RESULT_COUNT = 12;

const webSearchSchema = Type.Object({
	search_term: Type.String({
		description:
			"The search term to look up on the web. Be specific and include relevant keywords for better results. For technical queries, include version numbers or dates if relevant.",
	}),
	explanation: Type.Optional(
		Type.String({
			description: "One sentence explanation as to why this tool is being used, and how it contributes to the goal.",
		}),
	),
});

type WebSearchInput = Static<typeof webSearchSchema>;

interface SearchResultItem {
	title: string;
	url: string;
	snippet: string;
	age?: string;
}

interface CachedSearchEntry {
	query: string;
	results: SearchResultItem[];
	fetchedAtIso: string;
	expiresAtMs: number;
}

interface WebSearchDetails {
	provider: string;
	search_term: string;
	explanation?: string;
	result_count?: number;
	fetched_at?: string;
	from_cache?: boolean;
	output_truncated?: boolean;
	error?: string;
}

const responseCache = new Map<string, CachedSearchEntry>();

function normalizeSearchTerm(input: string): string {
	return input.trim();
}

function toSingleLine(text: string | undefined): string {
	if (!text) return "";
	return text.replace(/\s+/g, " ").trim();
}

function truncateSnippet(text: string, maxLength = 240): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function parseBraveResults(payload: unknown): SearchResultItem[] {
	if (typeof payload !== "object" || payload === null) {
		return [];
	}

	const asRecord = payload as Record<string, unknown>;
	const web = asRecord.web;
	if (typeof web !== "object" || web === null) {
		return [];
	}

	const results = (web as Record<string, unknown>).results;
	if (!Array.isArray(results)) {
		return [];
	}

	const parsed: SearchResultItem[] = [];
	for (const entry of results) {
		if (typeof entry !== "object" || entry === null) continue;
		const item = entry as Record<string, unknown>;

		const urlRaw = typeof item.url === "string" ? item.url.trim() : "";
		if (urlRaw.length === 0) continue;

		let safeUrl: string;
		try {
			safeUrl = new URL(urlRaw).toString();
		} catch {
			continue;
		}

		const title = toSingleLine(typeof item.title === "string" ? item.title : undefined) || "(untitled)";
		const description = toSingleLine(typeof item.description === "string" ? item.description : undefined);

		let snippet = description;
		if (snippet.length === 0 && Array.isArray(item.extra_snippets)) {
			for (const extra of item.extra_snippets) {
				if (typeof extra !== "string") continue;
				const normalized = toSingleLine(extra);
				if (normalized.length > 0) {
					snippet = normalized;
					break;
				}
			}
		}

		parsed.push({
			title,
			url: safeUrl,
			snippet: truncateSnippet(snippet),
			age: typeof item.age === "string" ? toSingleLine(item.age) : undefined,
		});

		if (parsed.length >= MAX_RESULT_COUNT) {
			break;
		}
	}

	return parsed;
}

function formatResultsOutput(query: string, fetchedAtIso: string, results: SearchResultItem[]): string {
	const lines: string[] = [];
	lines.push(`Provider: ${PROVIDER_NAME}`);
	lines.push(`Query: ${query}`);
	lines.push(`Fetched at: ${fetchedAtIso}`);
	lines.push("");

	if (results.length === 0) {
		lines.push("No web results found.");
		return lines.join("\n");
	}

	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		lines.push(`${i + 1}. [${result.title}](${result.url})`);
		if (result.snippet.length > 0) {
			lines.push(`   ${result.snippet}`);
		}
		if (result.age && result.age.length > 0) {
			lines.push(`   age: ${result.age}`);
		}
	}

	return lines.join("\n");
}

function formatErrorResult(params: WebSearchInput, message: string): { content: { type: "text"; text: string }[]; details: WebSearchDetails } {
	return {
		content: [{ type: "text", text: message }],
		details: {
			provider: PROVIDER_NAME,
			search_term: params.search_term,
			explanation: params.explanation,
			error: message,
		},
	};
}

function getCachedEntry(query: string): CachedSearchEntry | undefined {
	const cached = responseCache.get(query);
	if (!cached) return undefined;
	if (cached.expiresAtMs < Date.now()) {
		responseCache.delete(query);
		return undefined;
	}
	return cached;
}

async function runBraveSearch(query: string, signal?: AbortSignal): Promise<{ fetchedAtIso: string; results: SearchResultItem[] }> {
	const apiKey = process.env[BRAVE_SEARCH_API_KEY_ENV]?.trim();
	if (!apiKey) {
		throw new Error(
			`Missing ${BRAVE_SEARCH_API_KEY_ENV}. Set this environment variable to use ${PROVIDER_NAME}.`,
		);
	}

	const url = new URL(BRAVE_SEARCH_API_URL);
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(DEFAULT_RESULT_COUNT));
	url.searchParams.set("spellcheck", "1");
	url.searchParams.set("text_decorations", "0");

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		const response = await fetch(url, {
			method: "GET",
			headers: {
				Accept: "application/json",
				"X-Subscription-Token": apiKey,
				"User-Agent": "mono-pilot-web-search/0.1",
			},
			signal: controller.signal,
		});

		if (response.status === 401 || response.status === 403) {
			throw new Error(`${PROVIDER_NAME} authentication failed (HTTP ${response.status}). Check API key.`);
		}
		if (response.status === 429) {
			throw new Error(`${PROVIDER_NAME} rate limit reached (HTTP 429). Please retry later.`);
		}
		if (!response.ok) {
			throw new Error(`${PROVIDER_NAME} request failed: HTTP ${response.status} ${response.statusText || ""}`.trim());
		}

		const payload = (await response.json()) as unknown;
		const results = parseBraveResults(payload);
		return {
			fetchedAtIso: new Date().toISOString(),
			results,
		};
	} catch (error) {
		if (controller.signal.aborted) {
			if (signal?.aborted) {
				throw new Error("WebSearch error: operation aborted.");
			}
			throw new Error(`WebSearch error: request timed out after ${REQUEST_TIMEOUT_MS}ms.`);
		}
		if (error instanceof Error) throw error;
		throw new Error(String(error));
	} finally {
		clearTimeout(timeoutId);
		signal?.removeEventListener("abort", onAbort);
	}
}

export default function webSearchExtension(pi: ExtensionAPI) {
	// System prompt injection is handled centrally by system-prompt extension.

	pi.registerTool({
		name: "WebSearch",
		label: "WebSearch",
		description: DESCRIPTION,
		parameters: webSearchSchema,
		renderCall(args, theme) {
			const input = args as Partial<WebSearchInput>;
			const term = typeof input.search_term === "string" && input.search_term.trim().length > 0 ? input.search_term.trim() : "(missing search_term)";
			const displayTerm = term.length > 120 ? `${term.slice(0, 119)}…` : term;
			let text = theme.fg("toolTitle", theme.bold("WebSearch"));
			text += ` ${theme.fg("toolOutput", displayTerm)}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("muted", "Searching..."), 0, 0);
			}
			const textBlock = result.content.find(
				(entry): entry is { type: "text"; text: string } => entry.type === "text" && typeof entry.text === "string",
			);
			if (!textBlock) {
				return new Text(theme.fg("error", "No text result returned."), 0, 0);
			}
			const fullText = textBlock.text;
			const details = result.details as WebSearchDetails | undefined;
			const count = details?.result_count ?? 0;
			if (!expanded) {
				const summary = `${count} results (click or ${keyHint("expandTools", "to expand")})`;
				return new Text(theme.fg("muted", summary), 0, 0);
			}
			let text = fullText.split("\n").map((line: string) => theme.fg("toolOutput", line)).join("\n");
			text += theme.fg("muted", `\n(click or ${keyHint("expandTools", "to collapse")})`);
			return new Text(text, 0, 0);
		},
		async execute(_toolCallId, params: WebSearchInput, signal) {
			const query = normalizeSearchTerm(params.search_term);
			if (query.length === 0) {
				return formatErrorResult(params, "WebSearch error: search_term cannot be empty.");
			}

			const cached = getCachedEntry(query);
			if (cached) {
				const output = formatResultsOutput(query, cached.fetchedAtIso, cached.results);
				const truncation = truncateTail(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
				let finalText = truncation.content;
				if (truncation.truncated) {
					finalText += `\n\n[Output truncated to ${formatSize(DEFAULT_MAX_BYTES)} / ${DEFAULT_MAX_LINES} lines.]`;
				}

				return {
					content: [{ type: "text", text: finalText }],
					details: {
						provider: PROVIDER_NAME,
						search_term: query,
						explanation: params.explanation,
						result_count: cached.results.length,
						fetched_at: cached.fetchedAtIso,
						from_cache: true,
						output_truncated: truncation.truncated || undefined,
					} satisfies WebSearchDetails,
				};
			}

			try {
				const liveResult = await runBraveSearch(query, signal);
				const cacheEntry: CachedSearchEntry = {
					query,
					results: liveResult.results,
					fetchedAtIso: liveResult.fetchedAtIso,
					expiresAtMs: Date.now() + CACHE_TTL_MS,
				};
				responseCache.set(query, cacheEntry);

				const output = formatResultsOutput(query, cacheEntry.fetchedAtIso, cacheEntry.results);
				const truncation = truncateTail(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
				let finalText = truncation.content;
				if (truncation.truncated) {
					finalText += `\n\n[Output truncated to ${formatSize(DEFAULT_MAX_BYTES)} / ${DEFAULT_MAX_LINES} lines.]`;
				}

				return {
					content: [{ type: "text", text: finalText }],
					details: {
						provider: PROVIDER_NAME,
						search_term: query,
						explanation: params.explanation,
						result_count: cacheEntry.results.length,
						fetched_at: cacheEntry.fetchedAtIso,
						from_cache: false,
						output_truncated: truncation.truncated || undefined,
					} satisfies WebSearchDetails,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return formatErrorResult(params, `WebSearch error: ${message}`);
			}
		},
	});
}