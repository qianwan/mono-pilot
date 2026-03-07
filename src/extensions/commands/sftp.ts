import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Input, Text } from "@mariozechner/pi-tui";
import {
	downloadSftpPath,
	isSftpAuthFailure,
	loadSftpTargets,
	uploadSftpPath,
	type SftpTargetConfig,
} from "../sftp.js";

type NotifyLevel = "info" | "warning" | "error";

const USAGE = [
	"Usage:",
	"  /sftp upload <path>",
	"  /sftp download <path>",
	"  /sftp targets",
	"  /sftp target <targetName>",
].join("\n");

type SftpCommand = {
	cmd?: "upload" | "download" | "targets" | "target";
	path?: string;
	name?: string;
};

let selectedTargetName: string | undefined;

function parseSubcommand(input: string): SftpCommand {
	const trimmed = input.trim();
	if (!trimmed) return {};
	const lower = trimmed.toLowerCase();
	if (lower === "targets") {
		return { cmd: "targets" };
	}
	if (lower.startsWith("target ") || lower === "target") {
		const rawName = trimmed.slice("target".length).trim();
		return { cmd: "target", name: rawName || undefined };
	}
	const [commandRaw, ...rest] = trimmed.split(/\s+/);
	const command = commandRaw.toLowerCase();
	const path = rest.join(" ").trim();
	if (command !== "upload" && command !== "download") {
		return {};
	}
	return {
		cmd: command,
		path: path || undefined,
	};
}

function notify(
	ctx: ExtensionContext,
	message: string,
	level: NotifyLevel,
): void {
	if (ctx.hasUI && ctx.ui?.notify) {
		ctx.ui.notify(message, level);
		return;
	}
	const prefix = level === "error" ? "[error]" : level === "warning" ? "[warn]" : "[info]";
	console.log(`${prefix} ${message}`);
}

function formatTargets(targets: string[]): string {
	return targets.length > 0 ? targets.join(", ") : "(none)";
}

function describeTargetName(name: string | undefined, host: string): string {
	return name ? `${name} (${host})` : host;
}

function renderTargetList(targets: Array<{ name?: string; host: string }>): string {
	if (targets.length === 0) return "(none)";
	return targets
		.map((target, index) => {
			const label = describeTargetName(target.name, target.host);
			const isSelected =
				(selectedTargetName && target.name === selectedTargetName) ||
				(!selectedTargetName && index === targets.length - 1);
			return isSelected ? `* ${label}` : `  ${label}`;
		})
		.join("\n");
}

function pickTarget<T extends { name?: string; host: string }>(
	targets: T[],
	name: string | undefined,
): T | undefined {
	if (!name) return undefined;
	return targets.find((target) => target.name === name);
}

async function promptForOtp(ctx: ExtensionContext, labels: string[]): Promise<string | null> {
	if (!ctx.hasUI || !ctx.ui?.custom) {
		return null;
	}
	const title = labels.length === 1 ? `SFTP OTP (${labels[0]})` : `SFTP OTP (${labels.length} targets)`;
	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		container.addChild(new Text(theme.fg("muted", "Enter one-time code:"), 1, 0));
		const input = new Input();
		input.onSubmit = (value) => done(value.trim() || null);
		input.onEscape = () => done(null);
		container.addChild(input);
		container.addChild(new Text(theme.fg("dim", "enter submit • esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				input.handleInput(data);
				tui.requestRender();
			},
			get focused() {
				return input.focused;
			},
			set focused(value: boolean) {
				input.focused = value;
			},
		};
	}, { overlay: true });
}

export function registerSftpCommands(pi: ExtensionAPI): void {
	pi.registerCommand("sftp", {
		description: "Sync files with SFTP (.vscode/sftp.json)",
		handler: async (args, ctx) => {
			const parsed = parseSubcommand(args);
			if (!parsed.cmd) {
				notify(ctx, USAGE, "warning");
				return;
			}
			if ((parsed.cmd === "upload" || parsed.cmd === "download") && !parsed.path) {
				notify(ctx, USAGE, "warning");
				return;
			}

			let targets: SftpTargetConfig[];
			try {
				targets = await loadSftpTargets(ctx.cwd);
			} catch (error) {
				notify(ctx, (error as Error).message, "error");
				return;
			}
			if (targets.length === 0) {
				notify(ctx, "No SFTP targets found in .vscode/sftp.json.", "warning");
				return;
			}

			if (parsed.cmd === "targets") {
				notify(ctx, `SFTP targets:\n${renderTargetList(targets)}`, "info");
				return;
			}
			if (parsed.cmd === "target") {
				if (!parsed.name) {
					notify(ctx, `Missing target name.\n${USAGE}`, "warning");
					return;
				}
				const selected = pickTarget(targets, parsed.name);
				if (!selected) {
					notify(ctx, `Unknown target: ${parsed.name}`, "warning");
					notify(ctx, `Available targets:\n${renderTargetList(targets)}`, "info");
					return;
				}
				selectedTargetName = selected.name;
				const label = describeTargetName(selected.name, selected.host);
				notify(ctx, `SFTP target set to ${label}.`, "info");
				return;
			}

			const explicit = selectedTargetName ? pickTarget(targets, selectedTargetName) : undefined;
			if (selectedTargetName && !explicit) {
				notify(ctx, `Selected target not found: ${selectedTargetName}`, "warning");
				notify(ctx, `Available targets:\n${renderTargetList(targets)}`, "info");
				return;
			}
			const selectedTargets = [explicit ?? targets[targets.length - 1]!];
			const targetPath = parsed.path;
			if (!targetPath) {
				notify(ctx, USAGE, "warning");
				return;
			}

			const interactiveTargets = selectedTargets.filter((target) => target.interactiveAuth);
			let otp: string | null = null;

			const action = parsed.cmd;
			const runAction = async (otpValue: string | null) => {
				return action === "upload"
					? await uploadSftpPath({
							cwd: ctx.cwd,
							localPath: targetPath,
							targets: selectedTargets,
							otp: otpValue ?? undefined,
							requireExisting: false,
						})
					: await downloadSftpPath({
							cwd: ctx.cwd,
							localPath: targetPath,
							targets: selectedTargets,
							otp: otpValue ?? undefined,
							requireExisting: false,
						});
			};

			let details = await runAction(otp);
			if (interactiveTargets.length > 0 && !otp && isSftpAuthFailure(details.errors)) {
				if (!ctx.hasUI || !ctx.ui?.custom) {
					notify(ctx, "OTP input requires interactive UI.", "warning");
					return;
				}
				const labels = interactiveTargets.map((target) => target.name ?? target.host);
				otp = await promptForOtp(ctx, labels);
				if (!otp) {
					notify(ctx, "OTP input cancelled.", "warning");
					return;
				}
				details = await runAction(otp);
			}

			const countLabel = action === "upload" ? "uploaded" : "downloaded";
			const baseMessage = `${action} ${targetPath}: ${countLabel} ${details.uploaded} to ${formatTargets(
				details.targets,
			)}`;
			if (details.errors && details.errors.length > 0) {
				notify(ctx, `${baseMessage}\nerrors: ${details.errors.join("; ")}`, "warning");
				return;
			}
			notify(ctx, baseMessage, "info");
		},
	});
}