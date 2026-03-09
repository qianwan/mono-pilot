import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type NotifyLevel = "info" | "warning" | "error";

type TerminalInputListenerResult = { consume?: boolean; data?: string } | undefined;

export interface SystemEventsContext {
	hasUI?: boolean;
	ui?: {
		notify?: (message: string, type?: NotifyLevel) => void;
		onTerminalInput?: (handler: (data: string) => TerminalInputListenerResult) => () => void;
		custom?: <T>(
			factory: (
				tui: unknown,
				theme: unknown,
				keybindings: unknown,
				done: (result: T) => void,
			) => { render(width: number): string[]; invalidate(): void; dispose?(): void },
			options?: {
				overlay?: boolean;
				overlayOptions?: {
					anchor?:
						| "center"
						| "top-left"
						| "top-right"
						| "bottom-left"
						| "bottom-right"
						| "top-center"
						| "bottom-center"
						| "left-center"
						| "right-center";
					offsetX?: number;
					offsetY?: number;
					margin?: number;
					nonCapturing?: boolean;
					width?: number | `${number}%`;
					maxHeight?: number | `${number}%`;
				};
			},
		) => Promise<T>;
	};
}

interface SystemEventRecord {
	id: number;
	source: string;
	level: NotifyLevel;
	message: string;
	dedupeKey: string;
	firstSeenAtMs: number;
	lastSeenAtMs: number;
	count: number;
}

export interface PublishSystemEventInput {
	source: string;
	level: NotifyLevel;
	message: string;
	dedupeKey?: string;
	toast?: boolean;
	ctx?: SystemEventsContext;
}

type UiContext = SystemEventsContext;

const MAX_EVENTS = 200;
const COMMAND_DEFAULT_LIMIT = 20;
const DEDUPE_WINDOW_MS = 10_000;
const OVERLAY_FALLBACK_TIMEOUT_MS = 120_000;
const ERROR_OVERLAY_MIN_WIDTH = 44;
const ERROR_OVERLAY_MAX_WIDTH = 84;
const ERROR_OVERLAY_MAX_MESSAGE_LINES = 3;
const OVERLAY_MARGIN = 1;
const OVERLAY_OFFSET_X = 0;
const OVERLAY_OFFSET_Y = -4;
const OVERLAY_CLOSE_MARK = "[×]";
const OVERLAY_CLOSE_GLYPH = "×";

let lastErrorOverlayKey = "";
let lastErrorOverlayAtMs = 0;
const ERROR_OVERLAY_DEDUPE_WINDOW_MS = 1_800;

interface ActiveOverlay {
	id: symbol;
	close: () => void;
}

let activeOverlay: ActiveOverlay | null = null;

let nextId = 1;
let queue: SystemEventRecord[] = [];
let latestContext: UiContext | null = null;

function notify(
	ctx: UiContext | null | undefined,
	message: string,
	level: NotifyLevel,
): void {
	if (ctx?.hasUI && ctx.ui?.notify) {
		ctx.ui.notify(message, level);
		return;
	}
	const prefix = level === "error" ? "[error]" : level === "warning" ? "[warn]" : "[info]";
	console.log(`${prefix} ${message}`);
}

function trimMessage(message: string): string {
	const normalized = message.trim();
	return normalized.length > 0 ? normalized : "(empty message)";
}

function formatClock(timestampMs: number): string {
	return new Date(timestampMs).toISOString().slice(11, 19);
}

function levelTag(level: NotifyLevel): string {
	if (level === "error") return "E";
	if (level === "warning") return "W";
	return "I";
}

function summarizeCounts(): { error: number; warning: number; info: number } {
	let error = 0;
	let warning = 0;
	let info = 0;
	for (const item of queue) {
		if (item.level === "error") {
			error += 1;
			continue;
		}
		if (item.level === "warning") {
			warning += 1;
			continue;
		}
		info += 1;
	}
	return { error, warning, info };
}

function resetState(): void {
	nextId = 1;
	queue = [];
}

function shouldMergeWithLast(dedupeKey: string, now: number): SystemEventRecord | undefined {
	const last = queue[queue.length - 1];
	if (!last) {
		return undefined;
	}
	if (last.dedupeKey !== dedupeKey) {
		return undefined;
	}
	if (now - last.lastSeenAtMs > DEDUPE_WINDOW_MS) {
		return undefined;
	}
	return last;
}

function enqueueEvent(record: SystemEventRecord): void {
	queue.push(record);
	if (queue.length > MAX_EVENTS) {
		queue = queue.slice(queue.length - MAX_EVENTS);
	}
}

function shouldToast(level: NotifyLevel, explicit: boolean | undefined): boolean {
	if (typeof explicit === "boolean") {
		return explicit;
	}
	return level !== "info";
}

function wrapFixedWidth(text: string, width: number): string[] {
	const normalizedWidth = Math.max(8, width);
	const lines: string[] = [];
	for (const segment of text.split(/\r?\n/)) {
		if (segment.length === 0) {
			lines.push("");
			continue;
		}
		let cursor = 0;
		while (cursor < segment.length) {
			lines.push(segment.slice(cursor, cursor + normalizedWidth));
			cursor += normalizedWidth;
		}
	}
	return lines;
}

function padRight(value: string, width: number): string {
	if (value.length >= width) {
		return value.slice(0, width);
	}
	return value + " ".repeat(width - value.length);
}

function shouldShowOverlay(key: string, now: number): boolean {
	if (lastErrorOverlayKey !== key) {
		return true;
	}
	return now - lastErrorOverlayAtMs > ERROR_OVERLAY_DEDUPE_WINDOW_MS;
}

function closeActiveOverlay(): void {
	activeOverlay?.close();
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function isEscapeKey(data: string): boolean {
	return data === "\u001b";
}

function showOverlay(
	ctx: UiContext,
	level: NotifyLevel,
	source: string,
	message: string,
	dedupeKey: string,
): void {
	if (!ctx.hasUI || !ctx.ui?.custom) {
		return;
	}
	closeActiveOverlay();

	const now = Date.now();
	if (!shouldShowOverlay(dedupeKey, now)) {
		return;
	}
	lastErrorOverlayKey = dedupeKey;
	lastErrorOverlayAtMs = now;

	const overlayId = Symbol("system-overlay");
	let closeRequested: (() => void) | null = null;
	activeOverlay = {
		id: overlayId,
		close: () => {
			closeRequested?.();
		},
	};

	void ctx.ui
		.custom<void>(
			(tui, _theme, _keybindings, done) => {
				const tuiLike = tui as {
					terminal?: { columns?: number; rows?: number };
					addMouseListener?: (listener: (event: {
						action: string;
						button: string;
						x: number;
						y: number;
					}) => boolean | undefined) => () => void;
				};

				let closed = false;
				const closeOverlay = () => {
					if (closed) {
						return;
					}
					closed = true;
					done();
				};
				closeRequested = closeOverlay;

				const timer = setTimeout(() => {
					closeOverlay();
				}, OVERLAY_FALLBACK_TIMEOUT_MS);

				const onEsc = ctx.ui?.onTerminalInput?.((data) => {
					if (isEscapeKey(data)) {
						closeOverlay();
						return { consume: true };
					}
					return undefined;
				});

				const layoutState = {
					closeX: -1,
					closeY: -1,
				};

				const removeMouse = tuiLike.addMouseListener?.((event) => {
					if (closed) {
						return false;
					}
					if (event.action !== "press" || event.button !== "left") {
						return false;
					}
					if (event.y !== layoutState.closeY) {
						return false;
					}
					if (event.x !== layoutState.closeX) {
						return false;
					}
					closeOverlay();
					return true;
				});

				return {
					render(width: number): string[] {
						const panelWidth = Math.max(
							ERROR_OVERLAY_MIN_WIDTH,
							Math.min(width - 2, ERROR_OVERLAY_MAX_WIDTH),
						);
						const rowWidth = Math.max(24, panelWidth - 2);
						const rowInnerWidth = Math.max(16, rowWidth - 2);

						const messageChunks = wrapFixedWidth(message, rowInnerWidth);
						const visibleChunks = messageChunks.slice(0, ERROR_OVERLAY_MAX_MESSAGE_LINES);
						if (messageChunks.length > visibleChunks.length && visibleChunks.length > 0) {
							const last = visibleChunks[visibleChunks.length - 1] ?? "";
							visibleChunks[visibleChunks.length - 1] =
								last.length >= rowInnerWidth ? `${last.slice(0, rowInnerWidth - 3)}...` : `${last}...`;
						}

						const baseTitle = `${
							level === "error"
								? "SYSTEM ERROR"
								: level === "warning"
									? "SYSTEM WARNING"
									: "SYSTEM INFO"
						} [${source}]`;
						const titleLabelWidth = Math.max(1, rowInnerWidth - OVERLAY_CLOSE_MARK.length - 1);
						const title = `${padRight(baseTitle, titleLabelWidth)} ${OVERLAY_CLOSE_MARK}`;
						const rows: string[] = [
							`┌${"─".repeat(rowWidth)}┐`,
							`│ ${padRight(title, rowInnerWidth)} │`,
							`├${"─".repeat(rowWidth)}┤`,
						];

						if (visibleChunks.length === 0) {
							rows.push(`│ ${padRight("(no message)", rowInnerWidth)} │`);
						} else {
							for (const chunk of visibleChunks) {
								rows.push(`│ ${padRight(chunk, rowInnerWidth)} │`);
							}
						}

						rows.push(`└${"─".repeat(rowWidth)}┘`);

						const termWidth = Math.max(
							panelWidth,
							Math.floor(Number(tuiLike.terminal?.columns ?? panelWidth)) || panelWidth,
						);
						const termHeight = Math.max(8, Math.floor(Number(tuiLike.terminal?.rows ?? 24)) || 24);
						const overlayWidth = Math.max(1, Math.floor(width));
						const marginTop = OVERLAY_MARGIN;
						const marginBottom = OVERLAY_MARGIN;
						const marginLeft = OVERLAY_MARGIN;
						const marginRight = OVERLAY_MARGIN;
						const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
						const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

						let row = marginTop + Math.max(0, availHeight - rows.length);
						let col = marginLeft + Math.max(0, availWidth - overlayWidth);
						row += OVERLAY_OFFSET_Y;
						col += OVERLAY_OFFSET_X;
						row = clamp(row, marginTop, termHeight - marginBottom - rows.length);
						col = clamp(col, marginLeft, termWidth - marginRight - overlayWidth);

						const titleRowText = rows[1] ?? "";
						const closeOffset = titleRowText.indexOf(OVERLAY_CLOSE_MARK);
						const glyphOffset = OVERLAY_CLOSE_MARK.indexOf(OVERLAY_CLOSE_GLYPH);
						if (closeOffset >= 0 && glyphOffset >= 0) {
							layoutState.closeX = col + 1 + closeOffset + glyphOffset;
							layoutState.closeY = row + 2;
						}

						return rows;
					},
					invalidate(): void {
						// Stateless component.
					},
					dispose(): void {
						clearTimeout(timer);
						onEsc?.();
						removeMouse?.();
						if (activeOverlay?.id === overlayId) {
							activeOverlay = null;
						}
						closeRequested = null;
					},
				};
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "bottom-right",
					offsetX: OVERLAY_OFFSET_X,
					offsetY: OVERLAY_OFFSET_Y,
					margin: OVERLAY_MARGIN,
					nonCapturing: true,
					maxHeight: 8,
					width: "40%",
				},
			},
		)
		.finally(() => {
			if (activeOverlay?.id === overlayId) {
				activeOverlay = null;
			}
		})
		.catch(() => {
			// Overlay UI is best-effort only.
		});
}

export function publishSystemEvent(input: PublishSystemEventInput): void {
	const source = input.source.trim() || "system";
	const message = trimMessage(input.message);
	const now = Date.now();
	const dedupeKey = input.dedupeKey ?? `${source}|${input.level}|${message}`;
	const context = input.ctx ?? latestContext;

	const merged = shouldMergeWithLast(dedupeKey, now);
	if (merged) {
		merged.count += 1;
		merged.lastSeenAtMs = now;
		return;
	}

	const record: SystemEventRecord = {
		id: nextId++,
		source,
		level: input.level,
		message,
		dedupeKey,
		firstSeenAtMs: now,
		lastSeenAtMs: now,
		count: 1,
	};
	enqueueEvent(record);
	if (context) {
		showOverlay(context, record.level, record.source, record.message, record.dedupeKey);
	}

	if (shouldToast(input.level, input.toast)) {
		notify(context, `[${record.source}] ${record.message}`, record.level);
	}
}

function parseLimit(raw: string | undefined): number {
	if (!raw) {
		return COMMAND_DEFAULT_LIMIT;
	}
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return COMMAND_DEFAULT_LIMIT;
	}
	return Math.max(1, Math.min(100, Math.floor(parsed)));
}

function renderQueue(limit: number): string {
	if (queue.length === 0) {
		return "No system events.";
	}
	const counts = summarizeCounts();
	const lines = queue.slice(-limit).map((item) => {
		const repeated = item.count > 1 ? ` x${item.count}` : "";
		return `#${item.id} ${formatClock(item.lastSeenAtMs)} [${levelTag(item.level)}] [${item.source}] ${item.message}${repeated}`;
	});
	return [`Events total=${queue.length} e=${counts.error} w=${counts.warning} i=${counts.info}`, ...lines].join("\n");
}

export function registerSystemEvents(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		closeActiveOverlay();
		latestContext = ctx;
		resetState();
	});

	pi.on("session_shutdown", async () => {
		closeActiveOverlay();
		latestContext = null;
		resetState();
	});

	pi.registerCommand("events", {
		description: "System event queue: /events [N|clear]",
		handler: async (args, ctx) => {
			latestContext = ctx;
			const trimmed = args.trim();
			if (!trimmed) {
				notify(ctx, renderQueue(COMMAND_DEFAULT_LIMIT), "info");
				return;
			}

			if (trimmed === "clear") {
				queue = [];
				notify(ctx, "System event queue cleared.", "info");
				return;
			}

			const limit = parseLimit(trimmed);
			notify(ctx, renderQueue(limit), "info");
		},
	});
}