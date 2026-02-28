import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildMemoryIndex, type BuildMode } from "../../memory/build-memory.js";

type NotifyLevel = "info" | "warning" | "error";

const USAGE = "Usage: /build-memory --mode full|dirty";

function parseArgs(raw: string): { mode?: string; error?: string } {
	const tokens = raw.trim().split(/\s+/);
	let mode: string | undefined;

	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (!token) continue;

		if (token === "--mode") {
			mode = tokens[i + 1];
			i += 1;
			continue;
		}
		if (token.startsWith("--mode=")) {
			mode = token.slice("--mode=".length);
			continue;
		}
		return { error: `Unknown argument: ${token}. ${USAGE}` };
	}

	return { mode };
}

function isValidMode(value: string | undefined): value is BuildMode {
	return value === "full" || value === "dirty";
}

export function registerBuildMemoryCommand(pi: ExtensionAPI): void {
	pi.registerCommand("build-memory", {
		description: "Rebuild memory index. --mode full|dirty",
		handler: async (args, ctx) => {
			const parsed = parseArgs(args);

			if (parsed.error) {
				notify(ctx, parsed.error, "warning");
				return;
			}

			if (!isValidMode(parsed.mode)) {
				notify(ctx, `--mode is required (full or dirty). ${USAGE}`, "warning");
				return;
			}

			const mode: BuildMode = parsed.mode;

			notify(ctx, `Building memory index (mode=${mode})...`, "info");

			try {
				const result = await buildMemoryIndex({
					workspaceDir: ctx.cwd,
					mode,
				});

				if (result.ok) {
					notify(ctx, result.message, "info");
				} else {
					notify(ctx, result.message, "warning");
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notify(ctx, `build-memory failed: ${message}`, "error");
			}
		},
	});
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