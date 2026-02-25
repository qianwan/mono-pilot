import { spawn } from "node:child_process";
import {
	closeSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	formatSize,
	getShellConfig,
	keyHint,
	truncateTail,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";

// Tool docs are surfaced via system-prompt extension functions namespace.
const DEFAULT_BLOCK_UNTIL_MS = 30_000;
const UPDATE_RUNNING_SECONDS_EVERY_MS = 5_000;
const OUTPUT_CAPTURE_LIMIT_BYTES = DEFAULT_MAX_BYTES * 2;
const MAX_RENDER_COMMAND_CHARS = 180;
const MAX_COLLAPSED_RESULT_LINES = 5;
const DESCRIPTION = readFileSync(fileURLToPath(new URL("./shell-description.md", import.meta.url)), "utf-8").trim();

const shellSchema = Type.Object({
	command: Type.String({ description: "The command to execute" }),
	working_directory: Type.Optional(
		Type.String({
			description: "The absolute path to the working directory to execute the command in (defaults to current directory)",
		}),
	),
	block_until_ms: Type.Optional(
		Type.Number({
			description:
				"How long to block and wait for the command to complete before moving it to background (in milliseconds). Defaults to 30000ms (30 seconds). Set to 0 to immediately run the command in the background. The timer includes the shell startup time.",
		}),
	),
	description: Type.Optional(
		Type.String({
			description: "Clear, concise description of what this command does in 5-10 words",
		}),
	),
});

type ShellInput = Static<typeof shellSchema>;

interface TerminalCompletion {
	exitCode: number | null;
	elapsedMs: number;
	output: string;
	truncated: boolean;
}

interface TerminalSession {
	id: number;
	filePath: string;
	cwd: string;
	command: string;
	pid: number;
	startedAtMs: number;
	runningSecondsOffset: number;
	writeStream: ReturnType<typeof createWriteStream>;
	outputChunks: string[];
	outputChunkBytes: number;
	completionPromise: Promise<TerminalCompletion>;
	resolveCompletion: (completion: TerminalCompletion) => void;
	isFinished: boolean;
	backgrounded: boolean;
	headerTimer?: NodeJS.Timeout;
}

interface ForegroundWaitResult {
	completed: boolean;
	completion?: TerminalCompletion;
	reason?: "timeout" | "aborted";
}

interface ShellRuntimeState {
	cwd: string;
	env: NodeJS.ProcessEnv;
}

function compactCommandForRender(command: string): string {
	const singleLine = command.replace(/\s+/g, " ").trim();
	if (singleLine.length <= MAX_RENDER_COMMAND_CHARS) {
		return singleLine;
	}
	return `${singleLine.slice(0, MAX_RENDER_COMMAND_CHARS - 1)}…`;
}

function encodeWorkspacePath(workspace: string): string {
	return resolve(workspace)
		.replace(/^[A-Za-z]:/, (match) => match[0])
		.replace(/[\\/]/g, "-")
		.replace(/^-+/, "");
}

function getTerminalsDir(workspaceCwd: string): string {
	const workspaceKey = encodeWorkspacePath(workspaceCwd);
	const primary = join(resolve(workspaceCwd), ".pi", "terminals");
	try {
		mkdirSync(primary, { recursive: true });
		return primary;
	} catch {
		const fallback = join(tmpdir(), "pi-shell", workspaceKey, "terminals");
		mkdirSync(fallback, { recursive: true });
		return fallback;
	}
}

function getNextTerminalId(terminalsDir: string): number {
	const entries = readdirSync(terminalsDir, { withFileTypes: true });
	let maxId = 0;
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const match = entry.name.match(/^(\d+)\.txt$/);
		if (!match) continue;
		const id = Number.parseInt(match[1], 10);
		if (Number.isInteger(id) && id > maxId) maxId = id;
	}
	return maxId + 1;
}

function sanitizeOutputChunk(chunk: Buffer): string {
	return chunk.toString("utf-8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function parseEnvSnapshot(snapshot: Buffer): NodeJS.ProcessEnv {
	const parsed: NodeJS.ProcessEnv = {};
	const entries = snapshot.toString("utf-8").split("\0");
	for (const entry of entries) {
		if (entry.length === 0) continue;
		const separatorIndex = entry.indexOf("=");
		if (separatorIndex <= 0) continue;
		const key = entry.slice(0, separatorIndex);
		const value = entry.slice(separatorIndex + 1);
		parsed[key] = value;
	}
	return parsed;
}

function getCollapsedResultText(text: string, expanded: boolean): { output: string; remaining: number } {
	if (text.length === 0) {
		return { output: text, remaining: 0 };
	}

	const lines = text.split("\n");
	if (expanded || lines.length <= MAX_COLLAPSED_RESULT_LINES) {
		return { output: text, remaining: 0 };
	}

	// Show the *last* 20 lines for shell output (tail), since errors and final output usually appear at the end.
	// For backgrounded or partial it's fine, but typically we want the end of the log.
	return {
		output: lines.slice(-MAX_COLLAPSED_RESULT_LINES).join("\n"),
		remaining: lines.length - MAX_COLLAPSED_RESULT_LINES,
	};
}

function updateRunningSecondsInHeader(session: TerminalSession): void {
	const runningSeconds = Math.floor((Date.now() - session.startedAtMs) / 1000);
	const runningLine = `running_for_seconds: ${String(runningSeconds).padStart(10, "0")}\n`;
	try {
		const fd = openSync(session.filePath, "r+");
		try {
			writeSync(fd, runningLine, session.runningSecondsOffset, "utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		// Best effort; command execution should not fail due to metadata write failure.
	}
}

function appendCompletionFooter(
	session: TerminalSession,
	exitCode: number | null,
	elapsedMs: number,
	backgrounded: boolean,
): void {
	const finishedAt = new Date().toISOString();
	const footer = [
		"",
		"---",
		`exit_code: ${exitCode === null ? "null" : String(exitCode)}`,
		`elapsed_ms: ${elapsedMs}`,
		`backgrounded: ${String(backgrounded)}`,
		`finished_at: ${finishedAt}`,
		"---",
		"",
	].join("\n");
	session.writeStream.write(footer);
}

function killProcessTree(pid: number): void {
	if (!Number.isInteger(pid) || pid <= 0) return;

	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
			});
		} catch {
			// Ignore best-effort kill errors.
		}
		return;
	}

	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Process already gone.
		}
	}
}

function resolveWorkingDirectory(requested: string | undefined, workspaceCwd: string): string {
	if (!requested || requested.trim().length === 0) {
		return workspaceCwd;
	}
	const resolved = isAbsolute(requested) ? requested : resolve(workspaceCwd, requested);
	if (!existsSync(resolved)) {
		throw new Error(`Working directory does not exist: ${resolved}`);
	}
	const stats = statSync(resolved);
	if (!stats.isDirectory()) {
		throw new Error(`Working directory is not a directory: ${resolved}`);
	}
	return resolved;
}

function normalizeBlockUntilMs(value: number | undefined): number {
	if (value === undefined) return DEFAULT_BLOCK_UNTIL_MS;
	if (!Number.isFinite(value) || Number.isNaN(value)) return DEFAULT_BLOCK_UNTIL_MS;
	return Math.max(0, Math.floor(value));
}

function createTerminalSession(
	terminalsDir: string,
	command: string,
	cwd: string,
	runtimeState: ShellRuntimeState,
	activeSessions: Map<string, TerminalSession>,
): TerminalSession {
	const id = getNextTerminalId(terminalsDir);
	const filePath = join(terminalsDir, `${id}.txt`);
	const cwdSnapshotPath = join(terminalsDir, `${id}.state.cwd`);
	const envSnapshotPath = join(terminalsDir, `${id}.state.env`);
	const startedAtMs = Date.now();
	const startedAtIso = new Date(startedAtMs).toISOString();

	const { shell, args } = getShellConfig();
	const wrappedCommand =
		'cd "$1" || exit 1; eval "$2"; __pi_exit_code=$?; pwd > "$3"; env -0 > "$4"; exit $__pi_exit_code';
	const child = spawn(shell, [...args, wrappedCommand, "--", cwd, command, cwdSnapshotPath, envSnapshotPath], {
		cwd,
		detached: true,
		env: runtimeState.env,
		stdio: ["ignore", "pipe", "pipe"],
	});

	if (!child.pid) {
		throw new Error("Failed to start shell command: missing process pid.");
	}

	const pid = child.pid;
	const headerPrefix = `---\npid: ${pid}\n`;
	const runningLine = "running_for_seconds: 0000000000\n";
	const headerSafeCommand = command.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\\n");
	const headerSuffix = `cwd: ${cwd}\nlast_command: ${headerSafeCommand}\nstarted_at: ${startedAtIso}\n---\n`;
	const header = `${headerPrefix}${runningLine}${headerSuffix}`;
	const runningSecondsOffset = Buffer.byteLength(headerPrefix, "utf-8");

	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, header, "utf-8");

	const writeStream = createWriteStream(filePath, { flags: "a" });
	let resolveCompletion!: (completion: TerminalCompletion) => void;
	const completionPromise = new Promise<TerminalCompletion>((resolveCompletionFn) => {
		resolveCompletion = resolveCompletionFn;
	});

	const session: TerminalSession = {
		id,
		filePath,
		cwd,
		command,
		pid,
		startedAtMs,
		runningSecondsOffset,
		writeStream,
		outputChunks: [],
		outputChunkBytes: 0,
		completionPromise,
		resolveCompletion,
		isFinished: false,
		backgrounded: false,
	};

	const pushOutputChunk = (text: string) => {
		if (text.length === 0) return;
		session.writeStream.write(text);
		session.outputChunks.push(text);
		session.outputChunkBytes += Buffer.byteLength(text, "utf-8");
		while (session.outputChunkBytes > OUTPUT_CAPTURE_LIMIT_BYTES && session.outputChunks.length > 1) {
			const removed = session.outputChunks.shift() ?? "";
			session.outputChunkBytes -= Buffer.byteLength(removed, "utf-8");
		}
	};

	const finalize = (exitCode: number | null) => {
		if (session.isFinished) return;
		session.isFinished = true;
		activeSessions.delete(session.filePath);
		if (session.headerTimer) clearInterval(session.headerTimer);
		updateRunningSecondsInHeader(session);
		try {
			const nextCwd = readFileSync(cwdSnapshotPath, "utf-8").trim();
			if (nextCwd.length > 0 && existsSync(nextCwd) && statSync(nextCwd).isDirectory()) {
				runtimeState.cwd = nextCwd;
			}
		} catch {
			// Keep previous cwd when no snapshot is available.
		}
		try {
			const nextEnv = parseEnvSnapshot(readFileSync(envSnapshotPath));
			if (Object.keys(nextEnv).length > 0) {
				runtimeState.env = nextEnv;
			}
		} catch {
			// Keep previous environment when no snapshot is available.
		}
		try {
			unlinkSync(cwdSnapshotPath);
		} catch {
			// Best effort cleanup.
		}
		try {
			unlinkSync(envSnapshotPath);
		} catch {
			// Best effort cleanup.
		}
		const elapsedMs = Date.now() - session.startedAtMs;
		const output = session.outputChunks.join("");
		const truncation = truncateTail(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
		appendCompletionFooter(session, exitCode, elapsedMs, session.backgrounded);
		session.writeStream.end(() => {
			session.resolveCompletion({
				exitCode,
				elapsedMs,
				output: truncation.content,
				truncated: truncation.truncated,
			});
		});
	};

	child.stdout?.on("data", (chunk: Buffer) => {
		pushOutputChunk(sanitizeOutputChunk(chunk));
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		pushOutputChunk(sanitizeOutputChunk(chunk));
	});
	child.on("error", (error) => {
		pushOutputChunk(`\n[spawn error] ${error.message}\n`);
		finalize(null);
	});
	child.on("close", (code) => {
		finalize(code);
	});

	updateRunningSecondsInHeader(session);
	const timer = setInterval(() => updateRunningSecondsInHeader(session), UPDATE_RUNNING_SECONDS_EVERY_MS);
	timer.unref?.();
	session.headerTimer = timer;
	activeSessions.set(session.filePath, session);

	return session;
}

async function waitForeground(
	session: TerminalSession,
	blockUntilMs: number,
	signal: AbortSignal | undefined,
): Promise<ForegroundWaitResult> {
	if (blockUntilMs === 0) {
		session.backgrounded = true;
		return { completed: false, reason: "timeout" };
	}

	let timeoutId: NodeJS.Timeout | undefined;
	let abortHandler: (() => void) | undefined;

	const timeoutPromise = new Promise<"timeout">((resolveTimeout) => {
		timeoutId = setTimeout(() => resolveTimeout("timeout"), blockUntilMs);
	});
	const abortPromise = new Promise<"aborted">((resolveAbort) => {
		if (!signal) return;
		abortHandler = () => resolveAbort("aborted");
		if (signal.aborted) {
			resolveAbort("aborted");
		} else {
			signal.addEventListener("abort", abortHandler, { once: true });
		}
	});

	const result = await Promise.race<TerminalCompletion | "timeout" | "aborted">([
		session.completionPromise,
		timeoutPromise,
		abortPromise,
	]);

	if (timeoutId) clearTimeout(timeoutId);
	if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);

	if (result === "timeout") {
		session.backgrounded = true;
		return { completed: false, reason: "timeout" };
	}
	if (result === "aborted") {
		killProcessTree(session.pid);
		const completion = await session.completionPromise;
		return { completed: true, completion, reason: "aborted" };
	}
	return { completed: true, completion: result };
}

function formatForegroundOutput(
	completion: TerminalCompletion,
	terminalFile: string,
): { text: string; details: Record<string, unknown> } {
	const lines: string[] = [];
	const output = completion.output.trim();

	if (output.length > 0) {
		lines.push(output);
	} else {
		lines.push("(no output)");
	}

	if (completion.truncated) {
		lines.push("");
		lines.push(
			`[Output truncated to ${formatSize(DEFAULT_MAX_BYTES)} / ${DEFAULT_MAX_LINES} lines. Full output: ${terminalFile}]`,
		);
	}
	if (completion.exitCode !== 0 && completion.exitCode !== null) {
		lines.push("");
		lines.push(`Command exited with code ${completion.exitCode}`);
	}
	if (completion.exitCode === null) {
		lines.push("");
		lines.push("Command terminated before normal exit.");
	}

	return {
		text: lines.join("\n"),
		details: {
			backgrounded: false,
			terminal_file: terminalFile,
			exit_code: completion.exitCode,
			elapsed_ms: completion.elapsedMs,
			truncated: completion.truncated,
		},
	};
}

export default function (pi: ExtensionAPI) {
	const activeSessions = new Map<string, TerminalSession>();
	const runtimeStateByWorkspace = new Map<string, ShellRuntimeState>();
	const getRuntimeState = (workspaceCwd: string): ShellRuntimeState => {
		const workspaceKey = resolve(workspaceCwd);
		const existing = runtimeStateByWorkspace.get(workspaceKey);
		if (existing) {
			try {
				if (existsSync(existing.cwd) && statSync(existing.cwd).isDirectory()) {
					return existing;
				}
			} catch {
				// Fall through to reset state.
			}
		}
		const created: ShellRuntimeState = {
			cwd: workspaceCwd,
			env: { ...process.env },
		};
		runtimeStateByWorkspace.set(workspaceKey, created);
		return created;
	};
	// System prompt injection is handled centrally by system-prompt extension.

	pi.registerTool({
		name: "Shell",
		label: "Shell",
		description: DESCRIPTION,
		parameters: shellSchema,
		renderCall(args, theme) {
			const command = typeof args.command === "string" ? compactCommandForRender(args.command) : "(missing command)";
			const description = typeof args.description === "string" && args.description.trim().length > 0 ? args.description.trim() : undefined;

			let text = theme.fg("toolTitle", theme.bold("Shell"));
			if (description) {
				text += ` ${theme.fg("muted", `(${description})`)}`;
			}
			text += `\n${theme.fg("toolOutput", `$ ${command}`)}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("muted", "Running command..."), 0, 0);
			}

			const textBlock = result.content.find((entry): entry is any => entry.type === "text" && typeof (entry as any).text === "string");
			if (!textBlock || typeof textBlock.text !== "string") {
				return new Text("", 0, 0);
			}

			const { output, remaining } = getCollapsedResultText(textBlock.text, expanded);
			let text = output
				.split("\n")
				.map((line) => theme.fg("toolOutput", line))
				.join("\n");

			if (!expanded && remaining > 0) {
				// Since we tail the output, the remaining lines are *before* the shown ones.
				text = `${theme.fg("muted", `(... ${remaining} earlier lines, ${keyHint("expandTools", "to expand")})`)}\n${text}`;
			}

			return new Text(text, 0, 0);
		},
		async execute(_toolCallId, params: ShellInput, signal, _onUpdate, ctx) {
			const command = params.command?.trim();
			if (!command) {
				return {
					content: [{ type: "text", text: "Command is required." }],
					details: { error: "missing_command" },
				};
			}

			const runtimeState = getRuntimeState(ctx.cwd);
			const defaultWorkingDirectory = resolveWorkingDirectory(runtimeState.cwd, ctx.cwd);
			const workingDirectory = resolveWorkingDirectory(params.working_directory ?? defaultWorkingDirectory, ctx.cwd);
			const blockUntilMs = normalizeBlockUntilMs(params.block_until_ms);
			const terminalsDir = getTerminalsDir(ctx.cwd);

			const session = createTerminalSession(terminalsDir, command, workingDirectory, runtimeState, activeSessions);
			const waitResult = await waitForeground(session, blockUntilMs, signal);

			if (!waitResult.completed || !waitResult.completion) {
				session.backgrounded = true;
				return {
					content: [
						{
							type: "text",
							text:
								`Command moved to background.\n` +
								`terminal_file: ${session.filePath}\n` +
								`pid: ${session.pid}\n` +
								`Use read on the terminal file to monitor progress.`,
						},
					],
					details: {
						backgrounded: true,
						reason: waitResult.reason ?? "timeout",
						terminal_file: session.filePath,
						terminal_id: session.id,
						pid: session.pid,
						active_terminal_files: Array.from(activeSessions.keys()),
						working_directory: workingDirectory,
						block_until_ms: blockUntilMs,
						description: params.description,
					},
				};
			}

			const formatted = formatForegroundOutput(waitResult.completion, session.filePath);
			return {
				content: [{ type: "text", text: formatted.text }],
				details: {
					...formatted.details,
					terminal_id: session.id,
					pid: session.pid,
					working_directory: workingDirectory,
					block_until_ms: blockUntilMs,
					description: params.description,
				},
			};
		},
	});
}
