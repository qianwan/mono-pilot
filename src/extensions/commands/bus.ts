import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { BusHandle } from "../../cluster/bus.js";
import type { MessagePushPayload } from "../../cluster/protocol.js";

type NotifyLevel = "info" | "warning" | "error";

const USAGE = [
	"Usage:",
	"  /bus send <agentId> <message>   — send a direct message",
	"  /bus broadcast <message>        — broadcast to public channel",
	"  /bus broadcast:<channel> <msg>  — broadcast to specific channel",
	"  /bus who                        — list connected agents",
	"  /bus inbox                      — show received messages",
].join("\n");

/** Mutable slot — set once the bus is connected in session_start. */
let activeBus: BusHandle | null = null;
const inbox: MessagePushPayload[] = [];

export function setBusHandle(bus: BusHandle | null): void {
	activeBus = bus;
	if (bus) {
		bus.onMessage((msg) => {
			inbox.push(msg);
		});
	}
}

export function registerBusCommands(pi: ExtensionAPI): void {
	pi.registerCommand("bus", {
		description: "Message bus commands: send, broadcast, who",
		handler: async (args, ctx) => {
			if (!activeBus) {
				notify(ctx, "Bus not connected. Is the cluster running?", "warning");
				return;
			}

			const sub = parseSubcommand(args);

			switch (sub.cmd) {
				case "send": {
					if (!sub.target || !sub.body) {
						notify(ctx, "Usage: /bus send <agentId> <message>", "warning");
						return;
					}
					try {
						const { seq } = await activeBus.send(sub.target, { text: sub.body });
						notify(ctx, `→ [seq=${seq}] sent to ${sub.target}`, "info");
					} catch (err) {
						notify(ctx, `send failed: ${(err as Error).message}`, "error");
					}
					break;
				}

				case "broadcast": {
					if (!sub.body) {
						notify(ctx, "Usage: /bus broadcast <message>", "warning");
						return;
					}
					try {
						const { seq, delivered } = await activeBus.broadcast(
							{ text: sub.body },
							sub.channel,
						);
						const ch = sub.channel ?? "public";
						notify(ctx, `→ [seq=${seq}] broadcast to ${ch} (${delivered} recipients)`, "info");
					} catch (err) {
						notify(ctx, `broadcast failed: ${(err as Error).message}`, "error");
					}
					break;
				}

				case "who": {
					try {
						const { agents } = await activeBus.roster();
						if (agents.length === 0) {
							notify(ctx, "No agents connected", "info");
						} else {
							const lines = agents.map(
								(a) => `  ${a.agentId}  [${a.channels.join(", ")}]`,
							);
							notify(ctx, `Connected agents:\n${lines.join("\n")}`, "info");
						}
					} catch (err) {
						notify(ctx, `roster failed: ${(err as Error).message}`, "error");
					}
					break;
				}

				case "inbox": {
					if (inbox.length === 0) {
						notify(ctx, "No messages", "info");
					} else {
						const lines = inbox.map((m) => {
							const text = typeof m.payload === "object" && m.payload !== null && "text" in m.payload
								? (m.payload as { text: string }).text
								: JSON.stringify(m.payload);
							const ch = m.channel ? ` [${m.channel}]` : "";
							return `  [seq=${m.seq}] ${m.from}${ch}: ${text}`;
						});
						notify(ctx, `Messages (${inbox.length}):\n${lines.join("\n")}`, "info");
						inbox.length = 0;
					}
					break;
				}

				default:
					notify(ctx, `Unknown subcommand: ${sub.cmd ?? "(empty)"}\n${USAGE}`, "warning");
			}
		},
	});
}

// --- Parsing ---

interface Subcommand {
	cmd?: string;
	target?: string;   // for send
	channel?: string;  // for broadcast:<channel>
	body?: string;
}

function parseSubcommand(raw: string): Subcommand {
	const trimmed = raw.trim();
	if (!trimmed) return {};

	const spaceIdx = trimmed.indexOf(" ");
	const cmd = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
	const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

	if (cmd === "send") {
		const targetEnd = rest.indexOf(" ");
		if (targetEnd === -1) return { cmd, target: rest };
		return {
			cmd,
			target: rest.slice(0, targetEnd),
			body: rest.slice(targetEnd + 1).trim(),
		};
	}

	// broadcast or broadcast:<channel>
	if (cmd === "broadcast" || cmd.startsWith("broadcast:")) {
		const channel = cmd.includes(":") ? cmd.slice("broadcast:".length) : undefined;
		return { cmd: "broadcast", channel, body: rest };
	}

	return { cmd, body: rest };
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