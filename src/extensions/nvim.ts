import { spawnSync } from "node:child_process";
import { Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const NVIM_SHORTCUT = "alt+o";

function commandExists(command: string): boolean {
	const probe = process.platform === "win32" ? "where" : "which";
	const result = spawnSync(probe, [command], { stdio: "ignore", shell: process.platform === "win32" });
	return result.status === 0;
}

function resolveEditor(): "nvim" | "vim" | undefined {
	if (commandExists("nvim")) return "nvim";
	if (commandExists("vim")) return "vim";
	return undefined;
}

function runWorkspaceEditor(ctx: ExtensionContext, editor: "nvim" | "vim"): { ok: true } | { ok: false; reason: string } {
	const result = spawnSync(editor, [ctx.cwd], {
		stdio: "inherit",
		shell: process.platform === "win32",
		cwd: ctx.cwd,
	});

	if (result.error) {
		return { ok: false, reason: result.error.message };
	}

	if (result.status !== 0) {
		return { ok: false, reason: `${editor} exited with code ${result.status ?? 1}` };
	}

	return { ok: true };
}

async function openWorkspaceInEditor(
	ctx: ExtensionContext,
	editor: "nvim" | "vim",
): Promise<{ ok: true } | { ok: false; reason: string }> {
	if (!ctx.hasUI) {
		return runWorkspaceEditor(ctx, editor);
	}

	let launchResult: { ok: true } | { ok: false; reason: string } = {
		ok: false,
		reason: "Editor launch did not complete.",
	};

	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			queueMicrotask(() => {
				try {
					tui.stop();
					launchResult = runWorkspaceEditor(ctx, editor);
				} finally {
					tui.start();
					try {
						tui.terminal.enableMouse();
					} catch {
						// Best-effort: mouse capability differs across terminals.
					}
					tui.requestRender(true);
					done();
				}
			});

			return new Text(theme.fg("muted", `Opening ${editor}...`), 0, 0);
		},
		{ overlay: true },
	);

	return launchResult;
}

export default function nvimExtension(pi: ExtensionAPI): void {
	pi.registerShortcut(NVIM_SHORTCUT, {
		description: "Open workspace in nvim file explorer (fallback: vim)",
			handler: async (ctx) => {
				if (!ctx.hasUI) {
					return;
				}

			const editor = resolveEditor();
			if (!editor) {
				ctx.ui.notify("nvim/vim not found in PATH.", "warning");
				return;
			}

			const result = await openWorkspaceInEditor(ctx, editor);
			if (!result.ok) {
				ctx.ui.notify(`Failed to open ${editor}: ${result.reason}`, "warning");
			}
		},
	});
}
