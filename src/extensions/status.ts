import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

type NotifyLevel = "info" | "warning" | "error";

type UsageProviderId =
	| "anthropic"
	| "openai-codex"
	| "github-copilot"
	| "google-gemini-cli"
	| "minimax"
	| "zai";

interface UsageWindow {
	label: string;
	usedPercent: number;
	resetAt?: number;
}

interface ProviderUsageSnapshot {
	provider: UsageProviderId;
	displayName: string;
	windows: UsageWindow[];
	plan?: string;
	error?: string;
}

interface ParsedStatusArgs {
	timeoutMs: number;
	error?: string;
}

const DEFAULT_TIMEOUT_MS = 12000;
const USAGE = "Usage: /status [--timeout-ms <milliseconds>]";

const PROVIDER_LABELS: Record<UsageProviderId, string> = {
	anthropic: "Claude",
	"openai-codex": "Codex",
	"github-copilot": "Copilot",
	"google-gemini-cli": "Gemini CLI",
	minimax: "MiniMax",
	zai: "z.ai",
};

const PROVIDER_ALIASES: Record<string, UsageProviderId> = {
	anthropic: "anthropic",
	"openai-codex": "openai-codex",
	codex: "openai-codex",
	"github-copilot": "github-copilot",
	"google-gemini-cli": "google-gemini-cli",
	minimax: "minimax",
	"minimax-cn": "minimax",
	zai: "zai",
	"z-ai": "zai",
	"z.ai": "zai",
};

const MINIMAX_PERCENT_KEYS = ["used_percent", "usedPercent", "usage_percent", "usagePercent"] as const;
const MINIMAX_TOTAL_KEYS = ["total", "total_tokens", "totalTokens", "limit", "quota", "max"] as const;
const MINIMAX_USED_KEYS = ["used", "usage", "used_tokens", "usedTokens", "consumed"] as const;
const MINIMAX_REMAINING_KEYS = ["remaining", "remain", "remaining_tokens", "remainingTokens", "left"] as const;
const MINIMAX_RESET_KEYS = ["reset_at", "resetAt", "next_reset_time", "nextResetTime"] as const;

export function registerStatusCommand(pi: ExtensionAPI): void {
	pi.registerCommand("status", {
		description: "Show current model and provider usage windows",
		handler: async (args, ctx) => {
			const parsed = parseStatusArgs(args);
			if (parsed.error) {
				notify(ctx, `${parsed.error}\n${USAGE}`, "warning");
				return;
			}

			const model = ctx.model;
			if (!model) {
				notify(ctx, "No active model in this session.", "warning");
				return;
			}

			const providerId = resolveUsageProviderId(model.provider);
			const modelLine = `model: ${model.provider}/${model.id}`;
			const contextLine = formatContextLine(ctx);

			if (!providerId) {
				notify(ctx, [modelLine, contextLine, `usage: provider ${model.provider} is not supported yet`].join("\n"), "info");
				return;
			}

			const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
			if (!apiKey) {
				notify(ctx, [modelLine, contextLine, "usage: no credentials available for current provider"].join("\n"), "warning");
				return;
			}

			const token = normalizeProviderToken(providerId, apiKey);
			if (!token) {
				notify(ctx, [modelLine, contextLine, "usage: credentials format is not usable for usage lookup"].join("\n"), "warning");
				return;
			}

			const snapshot = await loadProviderUsageSnapshot({
				provider: providerId,
				token,
				timeoutMs: parsed.timeoutMs,
			});

			if (snapshot.error) {
				notify(ctx, [modelLine, contextLine, `usage: ${snapshot.displayName}: ${snapshot.error}`].join("\n"), "warning");
				return;
			}

			if (snapshot.windows.length === 0) {
				notify(ctx, [modelLine, contextLine, `usage: ${snapshot.displayName}: no usage window data`].join("\n"), "info");
				return;
			}

			const summary = formatUsageWindowSummary(snapshot, {
				now: Date.now(),
				maxWindows: 2,
				includeResets: true,
			});
			const planLine = snapshot.plan ? `plan: ${snapshot.plan}` : null;
			const usageLine = summary
				? `usage: ${snapshot.displayName} ${summary}`
				: `usage: ${snapshot.displayName}: no usage window data`;

			notify(ctx, [modelLine, contextLine, usageLine, planLine].filter(Boolean).join("\n"), "info");
		},
	});
}

function parseStatusArgs(raw: string): ParsedStatusArgs {
	const trimmed = raw.trim();
	if (!trimmed) {
		return { timeoutMs: DEFAULT_TIMEOUT_MS };
	}

	const tokens = trimmed.split(/\s+/);
	let timeoutMs = DEFAULT_TIMEOUT_MS;

	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token === "--timeout-ms") {
			const value = tokens[i + 1];
			if (!value) {
				return { timeoutMs, error: "--timeout-ms requires a value" };
			}
			const parsed = Number.parseInt(value, 10);
			if (!Number.isFinite(parsed) || parsed <= 0) {
				return { timeoutMs, error: `invalid --timeout-ms: ${value}` };
			}
			timeoutMs = parsed;
			i += 1;
			continue;
		}
		if (token.startsWith("--timeout-ms=")) {
			const value = token.slice("--timeout-ms=".length);
			const parsed = Number.parseInt(value, 10);
			if (!Number.isFinite(parsed) || parsed <= 0) {
				return { timeoutMs, error: `invalid --timeout-ms: ${value}` };
			}
			timeoutMs = parsed;
			continue;
		}
		return { timeoutMs, error: `unknown argument: ${token}` };
	}

	return { timeoutMs };
}

function resolveUsageProviderId(provider: string | undefined): UsageProviderId | undefined {
	if (!provider) {
		return undefined;
	}
	const normalized = provider.trim().toLowerCase();
	return PROVIDER_ALIASES[normalized];
}

function normalizeProviderToken(provider: UsageProviderId, raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed || trimmed === "<authenticated>") {
		return null;
	}

	if (provider !== "google-gemini-cli") {
		return trimmed;
	}

	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (isRecord(parsed) && typeof parsed.token === "string" && parsed.token.trim()) {
			return parsed.token.trim();
		}
	} catch {
		// Keep fallback below.
	}

	return trimmed;
}

async function loadProviderUsageSnapshot(params: {
	provider: UsageProviderId;
	token: string;
	timeoutMs: number;
}): Promise<ProviderUsageSnapshot> {
	try {
		switch (params.provider) {
			case "anthropic":
				return await fetchClaudeUsage(params.token, params.timeoutMs);
			case "openai-codex":
				return await fetchCodexUsage(params.token, params.timeoutMs);
			case "github-copilot":
				return await fetchCopilotUsage(params.token, params.timeoutMs);
			case "google-gemini-cli":
				return await fetchGeminiUsage(params.token, params.timeoutMs);
			case "zai":
				return await fetchZaiUsage(params.token, params.timeoutMs);
			case "minimax":
				return await fetchMiniMaxUsage(params.token, params.timeoutMs);
			default:
				return {
					provider: params.provider,
					displayName: PROVIDER_LABELS[params.provider],
					windows: [],
					error: "Unsupported provider",
				};
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			provider: params.provider,
			displayName: PROVIDER_LABELS[params.provider],
			windows: [],
			error: message,
		};
	}
}

async function fetchClaudeUsage(token: string, timeoutMs: number): Promise<ProviderUsageSnapshot> {
	const response = await fetchJson(
		"https://api.anthropic.com/api/oauth/usage",
		{
			headers: {
				Authorization: `Bearer ${token}`,
				"User-Agent": "mono-pilot",
				Accept: "application/json",
				"anthropic-version": "2023-06-01",
				"anthropic-beta": "oauth-2025-04-20",
			},
		},
		timeoutMs,
	);

	if (!response.ok) {
		return buildHttpErrorSnapshot("anthropic", response.status);
	}

	const payload = await readJsonObject(response);
	if (!payload) {
		return buildErrorSnapshot("anthropic", "Invalid JSON response");
	}

	const windows: UsageWindow[] = [];
	const fiveHour = getRecord(payload, "five_hour");
	const week = getRecord(payload, "seven_day");

	const fiveHourUsed = parseFiniteNumber(fiveHour?.utilization);
	if (fiveHourUsed !== undefined) {
		windows.push({
			label: "5h",
			usedPercent: normalizePercent(fiveHourUsed),
			resetAt: parseEpoch(fiveHour?.resets_at),
		});
	}

	const weekUsed = parseFiniteNumber(week?.utilization);
	if (weekUsed !== undefined) {
		windows.push({
			label: "Week",
			usedPercent: normalizePercent(weekUsed),
			resetAt: parseEpoch(week?.resets_at),
		});
	}

	return {
		provider: "anthropic",
		displayName: PROVIDER_LABELS.anthropic,
		windows,
	};
}

async function fetchCodexUsage(token: string, timeoutMs: number): Promise<ProviderUsageSnapshot> {
	const accountId = extractCodexAccountId(token);
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		"User-Agent": "CodexBar",
		Accept: "application/json",
	};
	if (accountId) {
		headers["ChatGPT-Account-Id"] = accountId;
	}

	const response = await fetchJson(
		"https://chatgpt.com/backend-api/wham/usage",
		{ method: "GET", headers },
		timeoutMs,
	);

	if (!response.ok) {
		return buildHttpErrorSnapshot("openai-codex", response.status, [401, 403]);
	}

	const payload = await readJsonObject(response);
	if (!payload) {
		return buildErrorSnapshot("openai-codex", "Invalid JSON response");
	}

	const rateLimit = getRecord(payload, "rate_limit");
	const primary = getRecord(rateLimit, "primary_window");
	const secondary = getRecord(rateLimit, "secondary_window");
	const windows: UsageWindow[] = [];

	const primaryUsed = parseFiniteNumber(primary?.used_percent);
	if (primaryUsed !== undefined) {
		const seconds = parseFiniteNumber(primary?.limit_window_seconds) ?? 10800;
		const hours = Math.max(1, Math.round(seconds / 3600));
		windows.push({
			label: `${hours}h`,
			usedPercent: normalizePercent(primaryUsed),
			resetAt: parseEpoch(primary?.reset_at),
		});
	}

	const secondaryUsed = parseFiniteNumber(secondary?.used_percent);
	if (secondaryUsed !== undefined) {
		const seconds = parseFiniteNumber(secondary?.limit_window_seconds) ?? 86400;
		const hours = Math.max(1, Math.round(seconds / 3600));
		const label = hours >= 168 ? "Week" : hours >= 24 ? "Day" : `${hours}h`;
		windows.push({
			label,
			usedPercent: normalizePercent(secondaryUsed),
			resetAt: parseEpoch(secondary?.reset_at),
		});
	}

	const credits = getRecord(payload, "credits");
	const planType = typeof payload.plan_type === "string" ? payload.plan_type.trim() : undefined;
	const balance = parseFiniteNumber(credits?.balance);
	const plan = balance !== undefined ? `${planType ?? "plan"} ($${balance.toFixed(2)})` : planType;

	return {
		provider: "openai-codex",
		displayName: PROVIDER_LABELS["openai-codex"],
		windows,
		plan,
	};
}

async function fetchCopilotUsage(token: string, timeoutMs: number): Promise<ProviderUsageSnapshot> {
	const response = await fetchJson(
		"https://api.github.com/copilot_internal/user",
		{
			headers: {
				Authorization: `token ${token}`,
				"Editor-Version": "vscode/1.96.2",
				"User-Agent": "GitHubCopilotChat/0.26.7",
				"X-Github-Api-Version": "2025-04-01",
			},
		},
		timeoutMs,
	);

	if (!response.ok) {
		return buildHttpErrorSnapshot("github-copilot", response.status, [401, 403]);
	}

	const payload = await readJsonObject(response);
	if (!payload) {
		return buildErrorSnapshot("github-copilot", "Invalid JSON response");
	}

	const windows: UsageWindow[] = [];
	const snapshots = getRecord(payload, "quota_snapshots");
	const premium = getRecord(snapshots, "premium_interactions");
	const chat = getRecord(snapshots, "chat");

	const premiumRemaining = parseFiniteNumber(premium?.percent_remaining);
	if (premiumRemaining !== undefined) {
		windows.push({
			label: "Premium",
			usedPercent: clampPercent(100 - normalizePercent(premiumRemaining)),
		});
	}

	const chatRemaining = parseFiniteNumber(chat?.percent_remaining);
	if (chatRemaining !== undefined) {
		windows.push({
			label: "Chat",
			usedPercent: clampPercent(100 - normalizePercent(chatRemaining)),
		});
	}

	const plan = typeof payload.copilot_plan === "string" ? payload.copilot_plan.trim() : undefined;

	return {
		provider: "github-copilot",
		displayName: PROVIDER_LABELS["github-copilot"],
		windows,
		plan,
	};
}

async function fetchGeminiUsage(token: string, timeoutMs: number): Promise<ProviderUsageSnapshot> {
	const response = await fetchJson(
		"https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: "{}",
		},
		timeoutMs,
	);

	if (!response.ok) {
		return buildHttpErrorSnapshot("google-gemini-cli", response.status, [401, 403]);
	}

	const payload = await readJsonObject(response);
	if (!payload) {
		return buildErrorSnapshot("google-gemini-cli", "Invalid JSON response");
	}

	const buckets = Array.isArray(payload.buckets) ? payload.buckets : [];
	let proRemaining: number | undefined;
	let flashRemaining: number | undefined;

	for (const entry of buckets) {
		if (!isRecord(entry)) {
			continue;
		}
		const modelId = typeof entry.modelId === "string" ? entry.modelId.toLowerCase() : "";
		const rawRemaining = parseFiniteNumber(entry.remainingFraction);
		if (rawRemaining === undefined) {
			continue;
		}
		const remaining = clamp01(rawRemaining <= 1 ? rawRemaining : rawRemaining / 100);
		if (modelId.includes("pro")) {
			proRemaining = proRemaining === undefined ? remaining : Math.min(proRemaining, remaining);
		}
		if (modelId.includes("flash")) {
			flashRemaining = flashRemaining === undefined ? remaining : Math.min(flashRemaining, remaining);
		}
	}

	const windows: UsageWindow[] = [];
	if (proRemaining !== undefined) {
		windows.push({ label: "Pro", usedPercent: clampPercent((1 - proRemaining) * 100) });
	}
	if (flashRemaining !== undefined) {
		windows.push({ label: "Flash", usedPercent: clampPercent((1 - flashRemaining) * 100) });
	}

	return {
		provider: "google-gemini-cli",
		displayName: PROVIDER_LABELS["google-gemini-cli"],
		windows,
	};
}

async function fetchZaiUsage(token: string, timeoutMs: number): Promise<ProviderUsageSnapshot> {
	const response = await fetchJson(
		"https://api.z.ai/api/monitor/usage/quota/limit",
		{
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/json",
			},
		},
		timeoutMs,
	);

	if (!response.ok) {
		return buildHttpErrorSnapshot("zai", response.status, [401, 403]);
	}

	const payload = await readJsonObject(response);
	if (!payload) {
		return buildErrorSnapshot("zai", "Invalid JSON response");
	}

	if (payload.success !== true || parseFiniteNumber(payload.code) !== 200) {
		const message = typeof payload.msg === "string" && payload.msg.trim() ? payload.msg.trim() : "API error";
		return buildErrorSnapshot("zai", message);
	}

	const data = getRecord(payload, "data");
	const limits = Array.isArray(data?.limits) ? data.limits : [];
	const windows: UsageWindow[] = [];

	for (const entry of limits) {
		if (!isRecord(entry)) {
			continue;
		}
		const type = typeof entry.type === "string" ? entry.type : "";
		const percentage = parseFiniteNumber(entry.percentage);
		if (percentage === undefined) {
			continue;
		}

		const unit = parseFiniteNumber(entry.unit);
		const count = parseFiniteNumber(entry.number);
		const windowLabel = unit === 1 ? `${count ?? 1}d` : unit === 3 ? `${count ?? 1}h` : unit === 5 ? `${count ?? 1}m` : "window";

		if (type === "TOKENS_LIMIT") {
			windows.push({
				label: `Tokens (${windowLabel})`,
				usedPercent: normalizePercent(percentage),
				resetAt: parseEpoch(entry.nextResetTime),
			});
		} else if (type === "TIME_LIMIT") {
			windows.push({
				label: "Monthly",
				usedPercent: normalizePercent(percentage),
				resetAt: parseEpoch(entry.nextResetTime),
			});
		}
	}

	const planName =
		typeof data?.planName === "string"
			? data.planName
			: typeof data?.plan === "string"
				? data.plan
				: undefined;

	return {
		provider: "zai",
		displayName: PROVIDER_LABELS.zai,
		windows,
		plan: planName,
	};
}

async function fetchMiniMaxUsage(token: string, timeoutMs: number): Promise<ProviderUsageSnapshot> {
	const response = await fetchJson(
		"https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains",
		{
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				"MM-API-Source": "mono-pilot",
			},
		},
		timeoutMs,
	);

	if (!response.ok) {
		return buildHttpErrorSnapshot("minimax", response.status, [401, 403]);
	}

	const payload = await readJsonObject(response);
	if (!payload) {
		return buildErrorSnapshot("minimax", "Invalid JSON response");
	}

	const baseResp = getRecord(payload, "base_resp");
	const statusCode = parseFiniteNumber(baseResp?.status_code);
	if (statusCode !== undefined && statusCode !== 0) {
		const message = typeof baseResp?.status_msg === "string" ? baseResp.status_msg : "API error";
		return buildErrorSnapshot("minimax", message);
	}

	const usagePayload = getRecord(payload, "data") ?? payload;
	const directPercent = pickFirstNumber(usagePayload, MINIMAX_PERCENT_KEYS);
	let usedPercent: number | undefined = directPercent !== undefined ? normalizePercent(directPercent) : undefined;

	if (usedPercent === undefined) {
		const total = pickFirstNumber(usagePayload, MINIMAX_TOTAL_KEYS);
		let used = pickFirstNumber(usagePayload, MINIMAX_USED_KEYS);
		const remaining = pickFirstNumber(usagePayload, MINIMAX_REMAINING_KEYS);
		if (used === undefined && remaining !== undefined && total !== undefined) {
			used = total - remaining;
		}
		if (total !== undefined && total > 0 && used !== undefined) {
			usedPercent = clampPercent((used / total) * 100);
		}
	}

	if (usedPercent === undefined) {
		return buildErrorSnapshot("minimax", "Unsupported response shape");
	}

	const windowHours = pickFirstNumber(usagePayload, ["window_hours", "windowHours"]);
	const windowMinutes = pickFirstNumber(usagePayload, ["window_minutes", "windowMinutes"]);
	const windowLabel =
		windowHours !== undefined
			? `${windowHours}h`
			: windowMinutes !== undefined
				? `${windowMinutes}m`
				: "5h";

	const plan = pickFirstString(usagePayload, ["plan", "plan_name", "planName", "tier"]);
	const resetAt = parseEpoch(pickFirstString(usagePayload, MINIMAX_RESET_KEYS));

	return {
		provider: "minimax",
		displayName: PROVIDER_LABELS.minimax,
		windows: [
			{
				label: windowLabel,
				usedPercent,
				resetAt,
			},
		],
		plan,
	};
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error("request timed out");
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

async function readJsonObject(response: Response): Promise<Record<string, unknown> | null> {
	try {
		const parsed = (await response.json()) as unknown;
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function getRecord(value: unknown, key: string): Record<string, unknown> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const child = value[key];
	return isRecord(child) ? child : undefined;
}

function parseFiniteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Number.parseFloat(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return undefined;
}

function parseEpoch(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value < 1e12 ? Math.floor(value * 1000) : Math.floor(value);
	}
	if (typeof value === "string") {
		const directNumber = Number.parseFloat(value);
		if (Number.isFinite(directNumber)) {
			return directNumber < 1e12 ? Math.floor(directNumber * 1000) : Math.floor(directNumber);
		}
		const parsedDate = Date.parse(value);
		if (Number.isFinite(parsedDate)) {
			return parsedDate;
		}
	}
	return undefined;
}

function normalizePercent(value: number): number {
	const scaled = value >= 0 && value <= 1 ? value * 100 : value;
	return clampPercent(scaled);
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.max(0, Math.min(100, value));
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.max(0, Math.min(1, value));
}

function pickFirstNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
	for (const key of keys) {
		const parsed = parseFiniteNumber(record[key]);
		if (parsed !== undefined) {
			return parsed;
		}
	}
	return undefined;
}

function pickFirstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function buildErrorSnapshot(provider: UsageProviderId, error: string): ProviderUsageSnapshot {
	return {
		provider,
		displayName: PROVIDER_LABELS[provider],
		windows: [],
		error,
	};
}

function buildHttpErrorSnapshot(
	provider: UsageProviderId,
	status: number,
	tokenExpiredStatuses: readonly number[] = [],
): ProviderUsageSnapshot {
	if (tokenExpiredStatuses.includes(status)) {
		return buildErrorSnapshot(provider, "Token expired");
	}
	return buildErrorSnapshot(provider, `HTTP ${status}`);
}

function extractCodexAccountId(token: string): string | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) {
		return undefined;
	}

	try {
		const payloadText = Buffer.from(parts[1], "base64url").toString("utf8");
		const payload = JSON.parse(payloadText) as unknown;
		if (!isRecord(payload)) {
			return undefined;
		}
		const authClaim = getRecord(payload, "https://api.openai.com/auth");
		const accountId = authClaim?.chatgpt_account_id;
		return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
	} catch {
		return undefined;
	}
}

function formatUsageWindowSummary(
	snapshot: ProviderUsageSnapshot,
	opts?: { now?: number; maxWindows?: number; includeResets?: boolean },
): string | null {
	if (snapshot.windows.length === 0) {
		return null;
	}
	const now = opts?.now ?? Date.now();
	const maxWindows =
		typeof opts?.maxWindows === "number" && opts.maxWindows > 0
			? Math.min(opts.maxWindows, snapshot.windows.length)
			: snapshot.windows.length;
	const includeResets = opts?.includeResets ?? false;

	const parts = snapshot.windows.slice(0, maxWindows).map((window) => {
		const remaining = clampPercent(100 - window.usedPercent);
		const reset = includeResets ? formatResetRemaining(window.resetAt, now) : null;
		const resetSuffix = reset ? ` \u23f1${reset}` : "";
		return `${window.label} ${remaining.toFixed(0)}% left${resetSuffix}`;
	});

	return parts.join(" \u00b7 ");
}

function formatResetRemaining(targetMs?: number, now = Date.now()): string | null {
	if (!targetMs || !Number.isFinite(targetMs)) {
		return null;
	}
	const diffMs = targetMs - now;
	if (diffMs <= 0) {
		return "now";
	}

	const diffMins = Math.floor(diffMs / 60000);
	if (diffMins < 60) {
		return `${diffMins}m`;
	}

	const hours = Math.floor(diffMins / 60);
	const mins = diffMins % 60;
	if (hours < 24) {
		return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
	}

	const days = Math.floor(hours / 24);
	if (days < 7) {
		return `${days}d ${hours % 24}h`;
	}

	return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(targetMs));
}

function formatContextLine(ctx: ExtensionCommandContext): string {
	const usage = ctx.getContextUsage();
	if (!usage) {
		return "context: unavailable";
	}
	const tokenLabel = usage.tokens === null ? "?" : String(usage.tokens);
	const percentLabel = usage.percent === null ? "?" : `${Math.round(usage.percent)}%`;
	return `context: ${tokenLabel}/${usage.contextWindow} (${percentLabel})`;
}

function notify(
	ctx: { hasUI?: boolean; ui?: { notify?: (msg: string, level?: NotifyLevel) => void } },
	message: string,
	level: NotifyLevel,
): void {
	if (ctx.hasUI && ctx.ui?.notify) {
		ctx.ui.notify(message, level);
	} else {
		const prefix = level === "error" ? "[error]" : level === "warning" ? "[warn]" : "[info]";
		console.log(`${prefix} ${message}`);
	}
}