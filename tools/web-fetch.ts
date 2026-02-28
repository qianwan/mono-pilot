import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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

const DESCRIPTION = `Fetch content from a specified URL and return its contents in a readable markdown format. Use this tool when you need to retrieve and analyze web content.

- The URL must be a fully-formed, valid URL.
- This tool is read-only and will not work for requests intended to have side effects.
- This fetch tries to return live results but may return previously cached content.
- This fetch runs from an isolated server - hosts like localhost or private IPs will not work.
- Authentication is not supported, and an error will be returned if the URL requires authentication.
- If the URL is returning a non-200 status code, e.g. 404, the tool will not return the content and will instead return an error message.
- The tool prefers markdown content negotiation via \`Accept: text/markdown\` when supported by the target site, and falls back to HTML-to-markdown conversion.
- If present, metadata like \`x-markdown-tokens\` and \`content-signal\` may be returned in tool details.`;

const REQUEST_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const ACCEPT_MARKDOWN_HEADER =
	"text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.8, application/json;q=0.7, text/plain;q=0.6, */*;q=0.5";

const webFetchSchema = Type.Object({
	url: Type.String({
		description: "The URL to fetch. The content will be converted to a readable markdown format.",
	}),
});

type WebFetchInput = Static<typeof webFetchSchema>;

interface CachedFetchEntry {
	url: string;
	finalUrl: string;
	status: number;
	contentType: string;
	markdownNegotiated: boolean;
	markdownTokens?: number;
	contentSignal?: string;
	markdownContent: string;
	fetchedAtIso: string;
	expiresAtMs: number;
}

interface WebFetchDetails {
	url: string;
	final_url?: string;
	status?: number;
	content_type?: string;
	markdown_negotiated?: boolean;
	markdown_tokens?: number;
	content_signal?: string;
	from_cache?: boolean;
	fetched_at?: string;
	bytes_received?: number;
	output_truncated?: boolean;
	error?: string;
}

const responseCache = new Map<string, CachedFetchEntry>();

function normalizeUrlInput(input: string): string {
	return input.trim();
}

function isPrivateIpv4(ipv4: string): boolean {
	const parts = ipv4.split(".").map((part) => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) {
		return false;
	}

	if (parts[0] === 10) return true;
	if (parts[0] === 127) return true;
	if (parts[0] === 169 && parts[1] === 254) return true;
	if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
	if (parts[0] === 192 && parts[1] === 168) return true;
	if (parts[0] === 0) return true;

	return false;
}

function isPrivateIpv6(ipv6: string): boolean {
	const normalized = ipv6.toLowerCase();
	if (normalized === "::1") return true;
	if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
	if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) {
		return true;
	}
	return false;
}

function isBlockedHostname(hostname: string): boolean {
	const lower = hostname.toLowerCase();
	if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local")) {
		return true;
	}

	const ipVersion = isIP(lower);
	if (ipVersion === 4) return isPrivateIpv4(lower);
	if (ipVersion === 6) return isPrivateIpv6(lower);

	return false;
}

async function resolvesToPrivateAddress(hostname: string): Promise<boolean> {
	if (isBlockedHostname(hostname)) return true;

	try {
		const records = await lookup(hostname, { all: true, verbatim: true });
		for (const record of records) {
			if (isBlockedHostname(record.address)) {
				return true;
			}
		}
	} catch {
		// Ignore DNS lookup failures; fetch() will surface actual network errors.
	}

	return false;
}

async function validateUrl(urlInput: string): Promise<URL> {
	const trimmed = normalizeUrlInput(urlInput);
	if (trimmed.length === 0) {
		throw new Error("URL is required.");
	}

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error(`Invalid URL: ${trimmed}`);
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Unsupported URL protocol: ${parsed.protocol}. Only http/https are allowed.`);
	}

	if (parsed.username || parsed.password) {
		throw new Error("Authentication in URL is not supported.");
	}

	if (await resolvesToPrivateAddress(parsed.hostname)) {
		throw new Error("Fetching localhost or private network hosts is not allowed.");
	}

	return parsed;
}

function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/&#x27;/gi, "'");
}

function parsePositiveInt(value: string | null): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value.trim(), 10);
	if (!Number.isFinite(parsed) || parsed < 0) return undefined;
	return parsed;
}

function stripHtmlToMarkdown(html: string): string {
	let text = html;

	text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
	text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
	text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
	text = text.replace(/<svg[\s\S]*?<\/svg>/gi, "");

	text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
	text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
	text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
	text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n");
	text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n");
	text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n");

	text = text.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, label: string) => {
		const safeLabel = decodeHtmlEntities(label).replace(/\s+/g, " ").trim() || href;
		return `[${safeLabel}](${href})`;
	});

	text = text.replace(/<li[^>]*>/gi, "\n- ");
	text = text.replace(/<(br|hr)\s*\/?\s*>/gi, "\n");
	text = text.replace(/<\/(p|div|section|article|header|footer|main|aside|table|tr|ul|ol)>/gi, "\n");
	text = text.replace(/<[^>]+>/g, " ");

	text = decodeHtmlEntities(text);
	text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	text = text
		.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter((line, index, lines) => {
			if (line.length > 0) return true;
			return index > 0 && lines[index - 1] !== "";
		})
		.join("\n");

	return text.trim();
}

function extractHtmlTitle(html: string): string | undefined {
	const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	if (!match?.[1]) return undefined;
	const normalized = decodeHtmlEntities(match[1]).replace(/\s+/g, " ").trim();
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeFetchedBody(rawText: string, contentType: string): { body: string; title?: string } {
	if (contentType.includes("text/markdown") || contentType.includes("text/md")) {
		return {
			body: rawText.trim(),
		};
	}

	if (contentType.includes("text/html")) {
		return {
			body: stripHtmlToMarkdown(rawText),
			title: extractHtmlTitle(rawText),
		};
	}

	if (contentType.includes("application/json")) {
		try {
			const parsed = JSON.parse(rawText);
			return {
				body: `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``,
			};
		} catch {
			// Fall back to plain text when content is invalid JSON.
		}
	}

	return {
		body: rawText.trim(),
	};
}

function formatFetchedOutput(entry: CachedFetchEntry): string {
	const lines: string[] = [];

	lines.push(`Source URL: ${entry.finalUrl}`);
	if (entry.url !== entry.finalUrl) {
		lines.push(`Requested URL: ${entry.url}`);
	}
	lines.push(`Fetched at: ${entry.fetchedAtIso}`);
	lines.push(`Content-Type: ${entry.contentType || "unknown"}`);
	lines.push(`Markdown negotiated: ${entry.markdownNegotiated ? "yes" : "no"}`);
	if (entry.markdownTokens !== undefined) {
		lines.push(`x-markdown-tokens: ${entry.markdownTokens}`);
	}
	if (entry.contentSignal) {
		lines.push(`content-signal: ${entry.contentSignal}`);
	}
	lines.push("");
	lines.push(entry.markdownContent.length > 0 ? entry.markdownContent : "(No readable text content found.)");

	return lines.join("\n");
}

function getCachedEntry(url: string): CachedFetchEntry | undefined {
	const cached = responseCache.get(url);
	if (!cached) return undefined;
	if (cached.expiresAtMs < Date.now()) {
		responseCache.delete(url);
		return undefined;
	}
	return cached;
}

function formatErrorResult(url: string, error: string): { content: { type: "text"; text: string }[]; details: WebFetchDetails } {
	return {
		content: [{ type: "text", text: error }],
		details: {
			url,
			error,
		},
	};
}

export default function webFetchExtension(pi: ExtensionAPI) {
	// System prompt injection is handled centrally by system-prompt extension.

	pi.registerTool({
		name: "WebFetch",
		label: "WebFetch",
		description: DESCRIPTION,
		parameters: webFetchSchema,
		renderCall(args, theme) {
			const input = args as Partial<WebFetchInput>;
			const url = typeof input.url === "string" && input.url.trim().length > 0 ? input.url.trim() : "(missing url)";
			const displayUrl = url.length > 120 ? `${url.slice(0, 119)}…` : url;
			let text = theme.fg("toolTitle", theme.bold("WebFetch"));
			text += ` ${theme.fg("toolOutput", displayUrl)}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("muted", "Fetching URL..."), 0, 0);
			}
			const textBlock = result.content.find(
				(entry): entry is { type: "text"; text: string } => entry.type === "text" && typeof entry.text === "string",
			);
			if (!textBlock) {
				return new Text(theme.fg("error", "No text result returned."), 0, 0);
			}
			const fullText = textBlock.text;
			const lineCount = fullText.split("\n").length;
			if (!expanded) {
				const summary = `${lineCount} lines (click or ${keyHint("expandTools", "to expand")})`;
				return new Text(theme.fg("muted", summary), 0, 0);
			}
			let text = fullText.split("\n").map((line: string) => theme.fg("toolOutput", line)).join("\n");
			text += theme.fg("muted", `\n(click or ${keyHint("expandTools", "to collapse")})`);
			return new Text(text, 0, 0);
		},
		async execute(_toolCallId, params: WebFetchInput, signal) {
			let parsedUrl: URL;
			try {
				parsedUrl = await validateUrl(params.url);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return formatErrorResult(params.url, `WebFetch error: ${message}`);
			}

			const normalizedUrl = parsedUrl.toString();
			const cached = getCachedEntry(normalizedUrl);
			if (cached) {
				const output = formatFetchedOutput(cached);
				const truncation = truncateTail(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
				let finalText = truncation.content;
				if (truncation.truncated) {
					finalText += `\n\n[Output truncated to ${formatSize(DEFAULT_MAX_BYTES)} / ${DEFAULT_MAX_LINES} lines.]`;
				}

				return {
					content: [{ type: "text", text: finalText }],
					details: {
						url: normalizedUrl,
						final_url: cached.finalUrl,
						status: cached.status,
						content_type: cached.contentType,
						markdown_negotiated: cached.markdownNegotiated,
						markdown_tokens: cached.markdownTokens,
						content_signal: cached.contentSignal,
						from_cache: true,
						fetched_at: cached.fetchedAtIso,
						bytes_received: Buffer.byteLength(cached.markdownContent, "utf-8"),
						output_truncated: truncation.truncated || undefined,
					} satisfies WebFetchDetails,
				};
			}

			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
			const onAbort = () => controller.abort();
			signal?.addEventListener("abort", onAbort, { once: true });

			try {
				const response = await fetch(normalizedUrl, {
					method: "GET",
					redirect: "follow",
					signal: controller.signal,
					headers: {
						Accept: ACCEPT_MARKDOWN_HEADER,
						"User-Agent": "mono-pilot-web-fetch/0.1",
					},
				});

				const finalUrl = response.url || normalizedUrl;
				const finalParsed = await validateUrl(finalUrl).catch(() => undefined);
				if (!finalParsed) {
					return formatErrorResult(normalizedUrl, "WebFetch error: redirected to an unsupported or private URL.");
				}

				if (response.status === 401 || response.status === 403) {
					return formatErrorResult(
						normalizedUrl,
						`WebFetch error: URL requires authentication (HTTP ${response.status}).`,
					);
				}

				if (!response.ok) {
					return formatErrorResult(
						normalizedUrl,
						`WebFetch error: received HTTP ${response.status} ${response.statusText || ""}`.trim(),
					);
				}

				const contentType = (response.headers.get("content-type") ?? "text/plain").toLowerCase();
				const markdownNegotiated = contentType.includes("text/markdown") || contentType.includes("text/md");
				const markdownTokens = parsePositiveInt(response.headers.get("x-markdown-tokens"));
				const contentSignal = response.headers.get("content-signal") ?? undefined;
				const rawText = await response.text();
				const normalizedBody = normalizeFetchedBody(rawText, contentType);
				const markdownBody = normalizedBody.title
					? `# ${normalizedBody.title}\n\n${normalizedBody.body}`.trim()
					: normalizedBody.body;

				const fetchedAtIso = new Date().toISOString();
				const cacheEntry: CachedFetchEntry = {
					url: normalizedUrl,
					finalUrl: finalParsed.toString(),
					status: response.status,
					contentType,
					markdownNegotiated,
					markdownTokens,
					contentSignal,
					markdownContent: markdownBody,
					fetchedAtIso,
					expiresAtMs: Date.now() + CACHE_TTL_MS,
				};
				responseCache.set(normalizedUrl, cacheEntry);

				const output = formatFetchedOutput(cacheEntry);
				const truncation = truncateTail(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
				let finalText = truncation.content;
				if (truncation.truncated) {
					finalText += `\n\n[Output truncated to ${formatSize(DEFAULT_MAX_BYTES)} / ${DEFAULT_MAX_LINES} lines.]`;
				}

				return {
					content: [{ type: "text", text: finalText }],
					details: {
						url: normalizedUrl,
						final_url: cacheEntry.finalUrl,
						status: cacheEntry.status,
						content_type: cacheEntry.contentType,
						markdown_negotiated: cacheEntry.markdownNegotiated,
						markdown_tokens: cacheEntry.markdownTokens,
						content_signal: cacheEntry.contentSignal,
						from_cache: false,
						fetched_at: cacheEntry.fetchedAtIso,
						bytes_received: Buffer.byteLength(rawText, "utf-8"),
						output_truncated: truncation.truncated || undefined,
					} satisfies WebFetchDetails,
				};
			} catch (error) {
				if (controller.signal.aborted) {
					const reason = signal?.aborted
						? "WebFetch error: operation aborted."
						: `WebFetch error: request timed out after ${REQUEST_TIMEOUT_MS}ms.`;
					return formatErrorResult(normalizedUrl, reason);
				}

				const message = error instanceof Error ? error.message : String(error);
				return formatErrorResult(normalizedUrl, `WebFetch error: ${message}`);
			} finally {
				clearTimeout(timeoutId);
				signal?.removeEventListener("abort", onAbort);
			}
		},
	});
}