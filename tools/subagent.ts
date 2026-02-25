import { spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";

const DESCRIPTION = readFileSync(fileURLToPath(new URL("./subagent-description.md", import.meta.url)), "utf-8").trim();

const SUBAGENTS_DIRNAME = ".pi/subagents";
const SUBAGENT_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;

const BUILTIN_SUBAGENT_TYPES = ["generalPurpose", "explore", "shell", "browser-use"] as const;
type SubagentType = (typeof BUILTIN_SUBAGENT_TYPES)[number];

type ModelAlias = "fast";
type TaskStatus = "queued" | "running" | "background_running" | "completed" | "failed";

const modelAliasSchema = Type.Union([Type.Literal("fast")], {
	description:
		'Optional model alias. If not provided, inherits from parent/model profile. "fast" runs the parent model with thinking effort set to low.',
});

const subagentTypeSchema = Type.Union(
	[
		Type.Literal("generalPurpose"),
		Type.Literal("explore"),
		Type.Literal("shell"),
		Type.Literal("browser-use"),
	],
	{ description: "Subagent type to use for this task." },
);

const subagentTaskSchema = Type.Object({
	description: Type.String({ description: "A short (3-5 words) description of the task" }),
	prompt: Type.String({ description: "The task for the agent to perform" }),
	model: Type.Optional(modelAliasSchema),
	resume: Type.Optional(Type.String({ description: "Optional agent ID to resume from a previous execution transcript." })),
	readonly: Type.Optional(Type.Boolean({ description: "If true, the subagent runs with restricted write-capable tools." })),
	subagent_type: subagentTypeSchema,
	attachments: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Optional array of absolute or workspace-relative file paths to images/videos passed to the subagent context.",
		}),
	),
	is_background: Type.Optional(Type.Boolean({ description: "Run this task asynchronously in background mode." })),
});

const subagentSchema = Type.Object({
	description: Type.Optional(Type.String({ description: "A short (3-5 words) description of the task" })),
	prompt: Type.Optional(Type.String({ description: "The task for the agent to perform" })),
	model: Type.Optional(modelAliasSchema),
	resume: Type.Optional(Type.String({ description: "Optional agent ID to resume from a previous execution transcript." })),
	readonly: Type.Optional(Type.Boolean({ description: "If true, the subagent runs with restricted write-capable tools." })),
	subagent_type: Type.Optional(subagentTypeSchema),
	attachments: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Optional array of absolute or workspace-relative file paths to images/videos passed to the subagent context.",
		}),
	),
	is_background: Type.Optional(Type.Boolean({ description: "Run asynchronously and return immediately." })),
	tasks: Type.Optional(
		Type.Array(subagentTaskSchema, {
			description: "Run multiple subagent tasks in parallel orchestration mode.",
			minItems: 1,
		}),
	),
	max_concurrency: Type.Optional(
		Type.Number({
			description: "Parallel execution concurrency (1-4). Defaults to 4.",
			minimum: 1,
			maximum: MAX_CONCURRENCY,
		}),
	),
});

type SubagentTaskInput = Static<typeof subagentTaskSchema>;
type SubagentInput = Static<typeof subagentSchema>;

interface ModelLike {
	id: string;
	provider: string;
	name?: string;
}

interface SubagentProfile {
	type: SubagentType;
	source: string;
	systemPrompt: string;
	defaultReadonly: boolean;
	defaultBackground: boolean;
	modelSpec?: string;
}

interface SubagentProfileOverride {
	type: SubagentType;
	source: string;
	systemPrompt?: string;
	readonly?: boolean;
	isBackground?: boolean;
	modelSpec?: string;
}

interface SessionArtifacts {
	id: string;
	sessionPath: string;
	outputPath: string;
	statePath: string;
	resumed: boolean;
}

interface SubagentStateRecord {
	id: string;
	status: "running" | "completed" | "failed";
	mode: "foreground" | "background";
	session_path: string;
	output_path: string;
	started_at: string;
	finished_at?: string;
	exit_code?: number;
	pid?: number;
}

interface StreamStats {
	parsedEvents: number;
	assistantMessages: number;
	lastAssistantText: string;
	errorMessage?: string;
	stopReason?: string;
}

interface SubagentRunResult {
	pid: number;
	exitCode: number;
	stdout: string;
	stderr: string;
	stats: StreamStats;
}

interface SelectedModel {
	provider: string;
	modelId: string;
	thinking?: "low";
}

interface NormalizedTaskInput {
	description: string;
	prompt: string;
	model?: ModelAlias;
	resume?: string;
	readonly?: boolean;
	subagent_type: SubagentType;
	attachments?: string[];
	is_background?: boolean;
}

interface SubagentTaskDetails {
	task_index: number;
	status: TaskStatus;
	subagent_id?: string;
	session_path?: string;
	output_path?: string;
	resumed?: boolean;
	subagent_type: SubagentType;
	profile_source?: string;
	readonly: boolean;
	description: string;
	tools: string[];
	attachments: string[];
	model_alias?: ModelAlias;
	selected_provider?: string;
	selected_model?: string;
	exit_code?: number;
	pid?: number;
	parsed_events: number;
	assistant_messages: number;
	stderr?: string;
	preview?: string;
	final_output?: string;
}

interface SubagentDetails {
	mode: "single" | "parallel";
	total_tasks: number;
	completed_tasks: number;
	running_tasks: number;
	failed_tasks: number;
	results: SubagentTaskDetails[];
}

interface ExecuteTaskOptions {
	ctx: ExtensionContext;
	piCliPath: string;
	overrides: Map<SubagentType, SubagentProfileOverride>;
	signal: AbortSignal | undefined;
	onProgress?: (detail: SubagentTaskDetails) => void;
}

function compact(value: string, maxLength: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function parseBooleanLike(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "true") return true;
	if (normalized === "false") return false;
	return undefined;
}

function normalizeSubagentTypeName(value: string | undefined): SubagentType | undefined {
	if (!value) return undefined;
	const normalized = value.trim();
	if (normalized === "generalPurpose") return "generalPurpose";
	if (normalized === "explore") return "explore";
	if (normalized === "shell") return "shell";
	if (normalized === "browser-use") return "browser-use";

	const lowered = normalized.toLowerCase();
	if (lowered === "generalpurpose" || lowered === "general-purpose") return "generalPurpose";
	if (lowered === "browser" || lowered === "browseruse" || lowered === "browser_use") return "browser-use";
	if (lowered === "explore") return "explore";
	if (lowered === "shell") return "shell";
	return undefined;
}

function resolvePiCliPath(): string {
	const codingAgentEntryUrl = import.meta.resolve("@mariozechner/pi-coding-agent");
	const codingAgentEntryPath = fileURLToPath(codingAgentEntryUrl);
	return resolve(dirname(codingAgentEntryPath), "cli.js");
}

function getBuiltinProfile(subagentType: SubagentType): SubagentProfile {
	const commonPrefix = [
		"You are a delegated subagent running in an isolated subprocess.",
		"You do not have access to parent conversation context except what is provided in the current task prompt.",
		"Return concise, actionable output for the parent agent.",
	];

	switch (subagentType) {
		case "explore":
			return {
				type: subagentType,
				source: "builtin",
				systemPrompt: [
					...commonPrefix,
					"Focus on codebase exploration. Prioritize fast location of relevant files and summarize findings with file paths.",
				].join("\n"),
				defaultReadonly: true,
				defaultBackground: false,
				modelSpec: "fast",
			};
		case "shell":
			return {
				type: subagentType,
				source: "builtin",
				systemPrompt: [
					...commonPrefix,
					"Focus on command execution tasks. Include exact commands and notable outputs in your summary.",
				].join("\n"),
				defaultReadonly: false,
				defaultBackground: false,
			};
		case "browser-use":
			return {
				type: subagentType,
				source: "builtin",
				systemPrompt: [
					...commonPrefix,
					"Focus on browser and web testing workflows.",
					"If browser tooling is unavailable in this runtime, clearly report that limitation and continue with available tools.",
				].join("\n"),
				defaultReadonly: false,
				defaultBackground: false,
			};
		case "generalPurpose":
		default:
			return {
				type: "generalPurpose",
				source: "builtin",
				systemPrompt: commonPrefix.join("\n"),
				defaultReadonly: false,
				defaultBackground: false,
			};
	}
}

function loadProfileOverrides(workspaceCwd: string): Map<SubagentType, SubagentProfileOverride> {
	const overrides = new Map<SubagentType, SubagentProfileOverride>();
	const dirsInAscendingPriority = [
		{ source: "user:.codex", dir: join(homedir(), ".codex", "agents") },
		{ source: "user:.claude", dir: join(homedir(), ".claude", "agents") },
		{ source: "user:.cursor", dir: join(homedir(), ".cursor", "agents") },
		{ source: "project:.codex", dir: resolve(workspaceCwd, ".codex", "agents") },
		{ source: "project:.claude", dir: resolve(workspaceCwd, ".claude", "agents") },
		{ source: "project:.cursor", dir: resolve(workspaceCwd, ".cursor", "agents") },
	] as const;

	for (const entry of dirsInAscendingPriority) {
		if (!existsSync(entry.dir)) continue;
		try {
			if (!statSync(entry.dir).isDirectory()) continue;
		} catch {
			continue;
		}

		let files: Array<{ name: string; isFile(): boolean; isSymbolicLink(): boolean }>;
		try {
			files = readdirSync(entry.dir, {
				withFileTypes: true,
				encoding: "utf8",
			}) as Array<{ name: string; isFile(): boolean; isSymbolicLink(): boolean }>;
		} catch {
			continue;
		}

		for (const file of files) {
			if (!file.isFile() && !file.isSymbolicLink()) continue;
			if (parse(file.name).ext.toLowerCase() !== ".md") continue;

			const absolutePath = join(entry.dir, file.name);
			let content = "";
			try {
				content = readFileSync(absolutePath, "utf-8");
			} catch {
				continue;
			}

			const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
			const fmType = typeof frontmatter.name === "string" ? normalizeSubagentTypeName(frontmatter.name) : undefined;
			const fileType = normalizeSubagentTypeName(parse(file.name).name);
			const type = fmType ?? fileType;
			if (!type) continue;

			const modelSpec = typeof frontmatter.model === "string" ? frontmatter.model.trim() : undefined;
			const readonly = parseBooleanLike(frontmatter.readonly);
			const isBackground = parseBooleanLike(frontmatter.is_background);
			const systemPrompt = body.trim();

			overrides.set(type, {
				type,
				source: `${entry.source}:${absolutePath}`,
				modelSpec: modelSpec && modelSpec.length > 0 ? modelSpec : undefined,
				readonly,
				isBackground,
				systemPrompt: systemPrompt.length > 0 ? systemPrompt : undefined,
			});
		}
	}

	return overrides;
}

function resolveProfile(subagentType: SubagentType, overrides: Map<SubagentType, SubagentProfileOverride>): SubagentProfile {
	const builtin = getBuiltinProfile(subagentType);
	const override = overrides.get(subagentType);
	if (!override) return builtin;

	return {
		type: subagentType,
		source: override.source,
		systemPrompt: override.systemPrompt ?? builtin.systemPrompt,
		defaultReadonly: override.readonly ?? builtin.defaultReadonly,
		defaultBackground: override.isBackground ?? builtin.defaultBackground,
		modelSpec: override.modelSpec ?? builtin.modelSpec,
	};
}

function listModelCandidates(ctx: ExtensionContext): ModelLike[] {
	const availableModels = ctx.modelRegistry.getAvailable() as unknown as ModelLike[];
	if (availableModels.length > 0) return [...availableModels];
	return [...(ctx.modelRegistry.getAll() as unknown as ModelLike[])];
}

function pickInheritedModel(ctx: ExtensionContext): SelectedModel | undefined {
	if (!ctx.model) return undefined;
	return { provider: ctx.model.provider, modelId: ctx.model.id };
}

function pickLowThinkingModel(ctx: ExtensionContext): SelectedModel | undefined {
	const inherited = pickInheritedModel(ctx);
	if (!inherited) return undefined;
	return { ...inherited, thinking: "low" };
}

function pickModelBySpec(ctx: ExtensionContext, spec: string): SelectedModel | undefined {
	const normalized = spec.trim();
	if (!normalized) return undefined;

	const lowered = normalized.toLowerCase();
	if (lowered === "inherit") return pickInheritedModel(ctx);
	if (lowered === "fast") return pickLowThinkingModel(ctx) ?? pickInheritedModel(ctx);

	const slashIndex = normalized.indexOf("/");
	if (slashIndex > 0) {
		const provider = normalized.slice(0, slashIndex);
		const modelId = normalized.slice(slashIndex + 1);
		if (provider && modelId && ctx.modelRegistry.find(provider, modelId)) {
			return { provider, modelId };
		}
	}

	if (ctx.model?.provider && ctx.modelRegistry.find(ctx.model.provider, normalized)) {
		return { provider: ctx.model.provider, modelId: normalized };
	}

	for (const candidate of listModelCandidates(ctx)) {
		if (candidate.id === normalized) {
			return { provider: candidate.provider, modelId: candidate.id };
		}
	}

	return undefined;
}

function selectModelForTask(
	ctx: ExtensionContext,
	explicitAlias: ModelAlias | undefined,
	profileModelSpec: string | undefined,
): SelectedModel | undefined {
	if (explicitAlias === "fast") {
		return pickLowThinkingModel(ctx) ?? pickInheritedModel(ctx);
	}

	if (profileModelSpec) {
		return pickModelBySpec(ctx, profileModelSpec) ?? pickInheritedModel(ctx);
	}

	return pickInheritedModel(ctx);
}

function normalizeResumeId(resumeId: string): string {
	const trimmed = resumeId.trim();
	if (!trimmed) {
		throw new Error("resume cannot be empty");
	}
	if (!SUBAGENT_ID_PATTERN.test(trimmed)) {
		throw new Error(`Invalid resume id: ${resumeId}`);
	}
	return trimmed;
}

function createSubagentId(): string {
	return `subagent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getSubagentsDir(workspaceCwd: string): string {
	const dir = resolve(workspaceCwd, SUBAGENTS_DIRNAME);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function getSessionArtifacts(workspaceCwd: string, id: string): Omit<SessionArtifacts, "resumed"> {
	const dir = getSubagentsDir(workspaceCwd);
	return {
		id,
		sessionPath: join(dir, `${id}.jsonl`),
		outputPath: join(dir, `${id}.log`),
		statePath: join(dir, `${id}.state.json`),
	};
}

function isProcessAlive(pid: number | undefined): boolean {
	if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
		return false;
	}
}

function readSubagentState(statePath: string): SubagentStateRecord | undefined {
	if (!existsSync(statePath)) return undefined;
	try {
		const raw = readFileSync(statePath, "utf-8");
		const parsed = JSON.parse(raw) as Partial<SubagentStateRecord>;
		if (!parsed || typeof parsed !== "object") return undefined;
		if (typeof parsed.id !== "string" || typeof parsed.status !== "string") return undefined;
		return parsed as SubagentStateRecord;
	} catch {
		return undefined;
	}
}

function writeSubagentState(statePath: string, state: SubagentStateRecord): void {
	writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function resolveSession(workspaceCwd: string, resumeId: string | undefined): SessionArtifacts {
	if (resumeId) {
		const id = normalizeResumeId(resumeId);
		const artifacts = getSessionArtifacts(workspaceCwd, id);

		if (!existsSync(artifacts.sessionPath)) {
			throw new Error(`Unable to resume subagent. Session file not found: ${artifacts.sessionPath}`);
		}
		if (!statSync(artifacts.sessionPath).isFile()) {
			throw new Error(`Unable to resume subagent. Session path is not a file: ${artifacts.sessionPath}`);
		}

		const state = readSubagentState(artifacts.statePath);
		if (state?.status === "running" && isProcessAlive(state.pid)) {
			throw new Error(
				`Subagent ${id} is still running in background (pid=${state.pid}). Wait for completion or inspect ${artifacts.outputPath}.`,
			);
		}

		return { ...artifacts, resumed: true };
	}

	while (true) {
		const id = createSubagentId();
		const artifacts = getSessionArtifacts(workspaceCwd, id);
		if (!existsSync(artifacts.sessionPath) && !existsSync(artifacts.statePath) && !existsSync(artifacts.outputPath)) {
			return { ...artifacts, resumed: false };
		}
	}
}

function resolveAttachmentPaths(attachments: string[] | undefined, workspaceCwd: string): string[] {
	if (!attachments || attachments.length === 0) return [];
	const resolvedPaths: string[] = [];

	for (const raw of attachments) {
		const trimmed = raw.trim();
		if (!trimmed) continue;
		const absolutePath = isAbsolute(trimmed) ? trimmed : resolve(workspaceCwd, trimmed);
		if (!existsSync(absolutePath)) {
			throw new Error(`Attachment does not exist: ${absolutePath}`);
		}
		if (!statSync(absolutePath).isFile()) {
			throw new Error(`Attachment is not a file: ${absolutePath}`);
		}
		resolvedPaths.push(absolutePath);
	}

	return resolvedPaths;
}

function getToolsForType(subagentType: SubagentType, readonlyMode: boolean): string[] {
	if (readonlyMode) {
		if (subagentType === "shell") return ["bash", "read", "grep", "find", "ls"];
		return ["read", "grep", "find", "ls"];
	}

	switch (subagentType) {
		case "explore":
			return ["read", "grep", "find", "ls"];
		case "shell":
			return ["bash", "read", "grep", "find", "ls", "edit", "write"];
		case "browser-use":
			return ["read", "bash", "grep", "find", "ls"];
		case "generalPurpose":
		default:
			return ["read", "bash", "grep", "find", "ls", "edit", "write"];
	}
}

function buildSystemPrompt(profile: SubagentProfile, readonlyMode: boolean): string {
	const lines = [profile.systemPrompt.trim()];
	if (readonlyMode) {
		lines.push("Readonly mode is enabled. Do not modify files.");
	}
	return lines.filter((line) => line.length > 0).join("\n\n");
}

function buildTaskPrompt(input: NormalizedTaskInput, attachments: string[], resumed: boolean): string {
	const lines = [
		`Task description: ${input.description}`,
		`Subagent type: ${input.subagent_type}`,
		resumed ? "Execution mode: resume an existing subagent session." : "Execution mode: fresh subagent session.",
		attachments.length > 0 ? `Attachments provided (${attachments.length}):` : "Attachments provided: 0",
	];

	for (const attachment of attachments) {
		lines.push(`- ${attachment}`);
	}

	lines.push("", "Task:", input.prompt, "", "Return the concrete result for the parent agent.");
	return lines.join("\n");
}

function getAssistantTextFromMessage(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const record = message as Record<string, unknown>;
	if (record.role !== "assistant") return undefined;
	const parts = record.content;
	if (!Array.isArray(parts)) return undefined;

	const textParts: string[] = [];
	for (const part of parts) {
		if (!part || typeof part !== "object") continue;
		const partRecord = part as Record<string, unknown>;
		if (partRecord.type === "text" && typeof partRecord.text === "string") {
			textParts.push(partRecord.text);
		}
	}

	if (textParts.length === 0) return undefined;
	return textParts.join("\n\n").trim();
}

function parseMessageMeta(message: unknown): { stopReason?: string; errorMessage?: string } {
	if (!message || typeof message !== "object") return {};
	const record = message as Record<string, unknown>;
	return {
		stopReason: typeof record.stopReason === "string" ? record.stopReason : undefined,
		errorMessage: typeof record.errorMessage === "string" ? record.errorMessage : undefined,
	};
}

function getProgressPreview(stats: StreamStats): string {
	if (stats.lastAssistantText.length > 0) return compact(stats.lastAssistantText, 220);
	return "(running...)";
}

async function runSubagentForeground(
	piCliPath: string,
	args: string[],
	cwd: string,
	signal: AbortSignal | undefined,
	onAssistantUpdate?: (stats: StreamStats) => void,
): Promise<SubagentRunResult> {
	return new Promise<SubagentRunResult>((resolveRun, rejectRun) => {
		const child = spawn(process.execPath, [piCliPath, ...args], {
			cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		if (!child.pid) {
			rejectRun(new Error("Failed to spawn subagent process: missing pid."));
			return;
		}

		let stdout = "";
		let stderr = "";
		let lineBuffer = "";
		let aborted = false;

		const stats: StreamStats = {
			parsedEvents: 0,
			assistantMessages: 0,
			lastAssistantText: "",
		};

		const parseLine = (line: string) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			let event: Record<string, unknown>;
			try {
				event = JSON.parse(trimmed) as Record<string, unknown>;
			} catch {
				return;
			}

			stats.parsedEvents++;

			if (event.type === "message_end" && event.message) {
				const text = getAssistantTextFromMessage(event.message);
				const meta = parseMessageMeta(event.message);
				if (meta.stopReason) stats.stopReason = meta.stopReason;
				if (meta.errorMessage) stats.errorMessage = meta.errorMessage;

				if (text) {
					stats.assistantMessages++;
					stats.lastAssistantText = text;
					onAssistantUpdate?.({ ...stats });
				}
			}
		};

		const onAbort = () => {
			aborted = true;
			if (!child.killed) {
				child.kill("SIGTERM");
				setTimeout(() => {
					if (!child.killed) child.kill("SIGKILL");
				}, 4000).unref?.();
			}
		};

		if (signal) {
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		child.stdout.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf-8");
			stdout += text;
			lineBuffer += text;
			const lines = lineBuffer.split("\n");
			lineBuffer = lines.pop() ?? "";
			for (const line of lines) parseLine(line);
		});

		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8");
		});

		child.on("error", (error) => {
			if (signal) signal.removeEventListener("abort", onAbort);
			rejectRun(new Error(`Failed to spawn subagent process: ${error.message}`));
		});

		child.on("close", (code) => {
			if (signal) signal.removeEventListener("abort", onAbort);
			if (lineBuffer.trim().length > 0) parseLine(lineBuffer);

			if (aborted) {
				rejectRun(new Error("Subagent execution aborted"));
				return;
			}

			resolveRun({
				pid: child.pid!,
				exitCode: code ?? 1,
				stdout,
				stderr,
				stats,
			});
		});
	});
}

function launchBackgroundSubagent(piCliPath: string, args: string[], cwd: string, outputPath: string): { pid: number } {
	mkdirSync(dirname(outputPath), { recursive: true });
	const outputFd = openSync(outputPath, "a");

	try {
		const child = spawn(process.execPath, [piCliPath, ...args], {
			cwd,
			env: process.env,
			detached: true,
			stdio: ["ignore", outputFd, outputFd],
		});

		if (!child.pid) {
			throw new Error("Failed to spawn background subagent process: missing pid.");
		}

		child.unref();
		return { pid: child.pid };
	} finally {
		try {
			closeSync(outputFd);
		} catch {
			// Best effort cleanup.
		}
	}
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	mapper: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results = new Array<TOut>(items.length);
	let nextIndex = 0;

	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex;
			nextIndex++;
			if (current >= items.length) return;
			results[current] = await mapper(items[current], current);
		}
	});

	await Promise.all(workers);
	return results;
}

function normalizeTaskInput(task: SubagentTaskInput, defaults: Pick<SubagentInput, "model" | "readonly" | "is_background">): NormalizedTaskInput {
	const description = task.description.trim();
	if (!description) {
		throw new Error("Task description cannot be empty.");
	}

	const prompt = task.prompt.trim();
	if (!prompt) {
		throw new Error("Task prompt cannot be empty.");
	}

	return {
		description,
		prompt,
		model: task.model ?? defaults.model,
		resume: task.resume,
		readonly: task.readonly ?? defaults.readonly,
		subagent_type: task.subagent_type,
		attachments: task.attachments,
		is_background: task.is_background ?? defaults.is_background,
	};
}

function normalizeSingleTaskInput(params: SubagentInput): NormalizedTaskInput {
	if (!params.description || !params.prompt || !params.subagent_type) {
		throw new Error(
			"Single mode requires description, prompt, and subagent_type. Or pass tasks[] for parallel orchestration mode.",
		);
	}

	const description = params.description.trim();
	if (!description) {
		throw new Error("description cannot be empty.");
	}

	const prompt = params.prompt.trim();
	if (!prompt) {
		throw new Error("prompt cannot be empty.");
	}

	return {
		description,
		prompt,
		model: params.model,
		resume: params.resume,
		readonly: params.readonly,
		subagent_type: params.subagent_type,
		attachments: params.attachments,
		is_background: params.is_background,
	};
}

function createQueuedTaskDetail(task: NormalizedTaskInput, index: number): SubagentTaskDetails {
	return {
		task_index: index,
		status: "queued",
		subagent_type: task.subagent_type,
		readonly: task.readonly ?? false,
		description: task.description,
		tools: [],
		attachments: [],
		model_alias: task.model,
		parsed_events: 0,
		assistant_messages: 0,
	};
}

function buildSubagentDetails(mode: "single" | "parallel", results: SubagentTaskDetails[]): SubagentDetails {
	const completedTasks = results.filter((result) => result.status === "completed").length;
	const runningTasks = results.filter(
		(result) => result.status === "running" || result.status === "background_running",
	).length;
	const failedTasks = results.filter((result) => result.status === "failed").length;

	return {
		mode,
		total_tasks: results.length,
		completed_tasks: completedTasks,
		running_tasks: runningTasks,
		failed_tasks: failedTasks,
		results,
	};
}

function formatBackgroundText(detail: SubagentTaskDetails): string {
	const lines = ["Subagent running in background."];
	if (detail.subagent_id) lines.push(`subagent_id: ${detail.subagent_id}`);
	if (detail.session_path) lines.push(`session_path: ${detail.session_path}`);
	if (detail.output_path) lines.push(`output_file: ${detail.output_path}`);
	if (detail.pid) lines.push(`pid: ${detail.pid}`);
	lines.push("Use Subagent with resume=<subagent_id> to continue after completion.");
	return lines.join("\n");
}

function formatParallelSummary(details: SubagentDetails): string {
	const lines: string[] = [
		`Parallel subagents: ${details.completed_tasks}/${details.total_tasks} completed, ${details.running_tasks} running, ${details.failed_tasks} failed.`,
	];

	for (const result of details.results) {
		const idText = result.subagent_id ? ` id=${result.subagent_id}` : "";
		const previewText = result.preview ? ` ${compact(result.preview, 100)}` : "";
		lines.push(`[${result.task_index + 1}] ${result.subagent_type} ${result.status}${idText}${previewText}`);
	}

	return lines.join("\n");
}

async function executeTask(task: NormalizedTaskInput, index: number, options: ExecuteTaskOptions): Promise<SubagentTaskDetails> {
	const profile = resolveProfile(task.subagent_type, options.overrides);
	const readonlyMode = task.readonly ?? profile.defaultReadonly;
	const isBackground = task.is_background ?? profile.defaultBackground;
	const selectedModel = selectModelForTask(options.ctx, task.model, profile.modelSpec);
	const attachments = resolveAttachmentPaths(task.attachments, options.ctx.cwd);
	const session = resolveSession(options.ctx.cwd, task.resume);
	const tools = getToolsForType(task.subagent_type, readonlyMode);

	const systemPrompt = buildSystemPrompt(profile, readonlyMode);
	const taskPrompt = buildTaskPrompt(task, attachments, session.resumed);

	const args: string[] = [
		"--mode",
		"json",
		"--print",
		"--session",
		session.sessionPath,
		"--no-extensions",
		"--no-tools",
		"--tools",
		tools.join(","),
		"--append-system-prompt",
		systemPrompt,
	];

	if (selectedModel) {
		args.push("--provider", selectedModel.provider, "--model", selectedModel.modelId);
		if (selectedModel.thinking === "low") {
			args.push("--thinking", "low");
		}
	}

	for (const attachment of attachments) {
		args.push(`@${attachment}`);
	}

	args.push(taskPrompt);

	const detail: SubagentTaskDetails = {
		task_index: index,
		status: "running",
		subagent_id: session.id,
		session_path: session.sessionPath,
		output_path: session.outputPath,
		resumed: session.resumed,
		subagent_type: task.subagent_type,
		profile_source: profile.source,
		readonly: readonlyMode,
		description: task.description,
		tools,
		attachments,
		model_alias: task.model,
		selected_provider: selectedModel?.provider,
		selected_model: selectedModel?.modelId,
		parsed_events: 0,
		assistant_messages: 0,
		preview: "(running...)",
	};

	options.onProgress?.({ ...detail });

	if (isBackground) {
		const startedAt = new Date().toISOString();
		try {
			const launched = launchBackgroundSubagent(options.piCliPath, args, options.ctx.cwd, session.outputPath);
			detail.status = "background_running";
			detail.pid = launched.pid;
			detail.preview = "Running in background";

			writeSubagentState(session.statePath, {
				id: session.id,
				status: "running",
				mode: "background",
				session_path: session.sessionPath,
				output_path: session.outputPath,
				started_at: startedAt,
				pid: launched.pid,
			});
			return detail;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			detail.status = "failed";
			detail.stderr = message;
			detail.exit_code = 1;
			detail.preview = compact(message, 220);
			return detail;
		}
	}

	writeSubagentState(session.statePath, {
		id: session.id,
		status: "running",
		mode: "foreground",
		session_path: session.sessionPath,
		output_path: session.outputPath,
		started_at: new Date().toISOString(),
	});

	try {
		const runResult = await runSubagentForeground(options.piCliPath, args, options.ctx.cwd, options.signal, (stats) => {
			detail.status = "running";
			detail.parsed_events = stats.parsedEvents;
			detail.assistant_messages = stats.assistantMessages;
			detail.preview = getProgressPreview(stats);
			options.onProgress?.({ ...detail });
		});

		const finalOutput = runResult.stats.lastAssistantText.trim() || runResult.stdout.trim();
		const isError =
			runResult.exitCode !== 0 || runResult.stats.stopReason === "error" || runResult.stats.stopReason === "aborted";

		detail.exit_code = runResult.exitCode;
		detail.parsed_events = runResult.stats.parsedEvents;
		detail.assistant_messages = runResult.stats.assistantMessages;
		detail.stderr = runResult.stderr.trim() || undefined;

		if (isError) {
			const errorText = runResult.stats.errorMessage || runResult.stderr.trim() || finalOutput || "Subagent execution failed.";
			detail.status = "failed";
			detail.preview = compact(errorText, 220);
			detail.final_output = errorText;

			writeSubagentState(session.statePath, {
				id: session.id,
				status: "failed",
				mode: "foreground",
				session_path: session.sessionPath,
				output_path: session.outputPath,
				started_at: readSubagentState(session.statePath)?.started_at ?? new Date().toISOString(),
				finished_at: new Date().toISOString(),
				exit_code: runResult.exitCode,
			});
			return detail;
		}

		detail.status = "completed";
		detail.final_output = finalOutput || "(no output)";
		detail.preview = compact(detail.final_output, 220);

		writeSubagentState(session.statePath, {
			id: session.id,
			status: "completed",
			mode: "foreground",
			session_path: session.sessionPath,
			output_path: session.outputPath,
			started_at: readSubagentState(session.statePath)?.started_at ?? new Date().toISOString(),
			finished_at: new Date().toISOString(),
			exit_code: runResult.exitCode,
		});
		return detail;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		detail.status = "failed";
		detail.exit_code = 1;
		detail.stderr = message;
		detail.preview = compact(message, 220);
		detail.final_output = message;

		writeSubagentState(session.statePath, {
			id: session.id,
			status: "failed",
			mode: "foreground",
			session_path: session.sessionPath,
			output_path: session.outputPath,
			started_at: readSubagentState(session.statePath)?.started_at ?? new Date().toISOString(),
			finished_at: new Date().toISOString(),
			exit_code: 1,
		});
		return detail;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "Subagent",
		label: "Subagent",
		description: DESCRIPTION,
		parameters: subagentSchema,
		renderCall(args, theme) {
			const params = args as SubagentInput;

			if (params.tasks && params.tasks.length > 0) {
				let text = theme.fg("toolTitle", theme.bold("Subagent"));
				text += ` ${theme.fg("toolOutput", `parallel x${params.tasks.length}`)}`;
				if (params.max_concurrency !== undefined) {
					text += ` ${theme.fg("dim", `concurrency=${params.max_concurrency}`)}`;
				}
				if (params.is_background) {
					text += ` ${theme.fg("dim", "background=true")}`;
				}
				return new Text(text, 0, 0);
			}

			const description = compact(params.description ?? "", 48);
			const type = params.subagent_type ?? "(missing type)";
			const suffix: string[] = [];
			if (params.model) suffix.push(`model=${params.model}`);
			if (params.readonly) suffix.push("readonly=true");
			if (params.is_background) suffix.push("background=true");
			if (params.resume) suffix.push(`resume=${compact(params.resume, 18)}`);
			if (params.attachments && params.attachments.length > 0) suffix.push(`attachments=${params.attachments.length}`);

			let text = theme.fg("toolTitle", theme.bold("Subagent"));
			text += ` ${theme.fg("toolOutput", type)}`;
			if (description.length > 0) text += ` ${theme.fg("muted", description)}`;
			if (suffix.length > 0) {
				text += ` ${theme.fg("dim", suffix.join(" "))}`;
			}
			return new Text(text, 0, 0);
		},
		async execute(_toolCallId, params: SubagentInput, signal, onUpdate, ctx) {
			try {
				const piCliPath = resolvePiCliPath();
				const overrides = loadProfileOverrides(ctx.cwd);

				if (params.tasks && params.tasks.length > 0) {
					if (params.tasks.length > MAX_PARALLEL_TASKS) {
						return {
							content: [
								{ type: "text", text: `Too many tasks (${params.tasks.length}). Maximum is ${MAX_PARALLEL_TASKS}.` },
							],
							details: {
								mode: "parallel",
								total_tasks: params.tasks.length,
								completed_tasks: 0,
								running_tasks: 0,
								failed_tasks: params.tasks.length,
								results: [],
							} satisfies SubagentDetails,
							isError: true,
						};
					}

					const defaults = {
						model: params.model,
						readonly: params.readonly,
						is_background: params.is_background,
					} satisfies Pick<SubagentInput, "model" | "readonly" | "is_background">;

					const normalizedTasks = params.tasks.map((task) => normalizeTaskInput(task, defaults));
					const maxConcurrency = Math.max(
						1,
						Math.min(MAX_CONCURRENCY, Math.floor(params.max_concurrency ?? MAX_CONCURRENCY)),
					);

					const results = normalizedTasks.map((task, index) => createQueuedTaskDetail(task, index));
					const emitUpdate = () => {
						onUpdate?.({
							content: [{ type: "text", text: formatParallelSummary(buildSubagentDetails("parallel", results)) }],
							details: buildSubagentDetails("parallel", [...results]),
						});
					};

					emitUpdate();

					await mapWithConcurrencyLimit(normalizedTasks, maxConcurrency, async (task, index) => {
						const outcome = await executeTask(task, index, {
							ctx,
							piCliPath,
							overrides,
							signal,
							onProgress: (detail) => {
								results[index] = detail;
								emitUpdate();
							},
						});
						results[index] = outcome;
						emitUpdate();
						return outcome;
					});

					const finalDetails = buildSubagentDetails("parallel", results);
					return {
						content: [{ type: "text", text: formatParallelSummary(finalDetails) }],
						details: finalDetails,
						isError: finalDetails.failed_tasks > 0,
					};
				}

				const singleTask = normalizeSingleTaskInput(params);
				let lastProgress: SubagentTaskDetails | undefined;

				const result = await executeTask(singleTask, 0, {
					ctx,
					piCliPath,
					overrides,
					signal,
					onProgress: (detail) => {
						lastProgress = detail;
						onUpdate?.({
							content: [{ type: "text", text: detail.preview ?? "(running...)" }],
							details: buildSubagentDetails("single", [detail]),
						});
					},
				});

				const finalDetails = buildSubagentDetails("single", [result]);

				if (result.status === "background_running") {
					return {
						content: [{ type: "text", text: formatBackgroundText(result) }],
						details: finalDetails,
					};
				}

				if (result.status === "failed") {
					return {
						content: [{ type: "text", text: `Subagent failed: ${result.final_output ?? result.preview ?? "unknown error"}` }],
						details: finalDetails,
						isError: true,
					};
				}

				return {
					content: [{ type: "text", text: result.final_output ?? "(no output)" }],
					details: finalDetails,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Subagent failed: ${message}` }],
					details: {
						mode: "single",
						total_tasks: 1,
						completed_tasks: 0,
						running_tasks: 0,
						failed_tasks: 1,
						results: [
							{
								task_index: 0,
								status: "failed",
								subagent_type: params.subagent_type ?? "generalPurpose",
								readonly: params.readonly ?? false,
								description: params.description?.trim() || "(missing description)",
								tools: [],
								attachments: [],
								parsed_events: 0,
								assistant_messages: 0,
								preview: compact(message, 220),
								stderr: message,
								final_output: message,
							},
						],
					} satisfies SubagentDetails,
					isError: true,
				};
			}
		},
	});
}