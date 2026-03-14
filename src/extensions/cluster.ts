import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { BusHandle } from "../cluster/bus.js";
import type { MessagePushPayload } from "../cluster/protocol.js";
import { closeCluster, getActiveClusterService } from "../cluster/init.js";
import { buildMemoryIndex, type BuildMode } from "../memory/build-memory.js";
import { publishSystemEvent } from "./system-events.js";
import {
	closeClusterV2,
	getActiveClusterV2Service,
	reelectClusterV2,
	stepdownClusterV2Leader,
} from "../cluster_v2/index.js";

type NotifyLevel = "info" | "warning" | "error";

const USAGE = [
	"Usage:",
	"  /cluster send <agentId> <message>   — send a direct message",
	"  /cluster broadcast <message>        — broadcast to public channel",
	"  /cluster broadcast:<channel> <msg>  — broadcast to specific channel",
	"  /cluster who                        — list connected agents",
	"  /cluster inbox                      — show received messages",
	"  /cluster status                     — show runtime cluster status",
	"  /cluster services                   — show cluster_v2 service registry",
	"  /cluster sync-memory [--mode <mode>] — rebuild memory index (default: dirty)",
	"  /cluster reelect                    — force this node to re-elect/rejoin",
	"  /cluster stepdown                   — leader steps down and rejoins",
	"  /cluster close                      — close local cluster subsystem",
].join("\n");

const SYNC_MEMORY_USAGE = "Usage: /cluster sync-memory [--mode full|dirty] (default: dirty)";

/** Mutable slot — set once the bus is connected in session_start. */
const inbox: MessagePushPayload[] = [];
let defaultBroadcastChannel: string | undefined;

function resolveClusterBusHandle(): BusHandle | null {
	const activeV2 = getActiveClusterV2Service();
	if (activeV2?.bus) {
		return activeV2.bus;
	}
	const activeV1 = getActiveClusterService();
	if (activeV1?.bus) {
		return activeV1.bus;
	}
	return null;
}

export function setClusterHandle(bus: BusHandle | null): void {
	if (!bus) {
		return;
	}
	bus.onMessage((msg) => {
		inbox.push(msg);
	});
}

export function setClusterCommandDefaultChannel(channel: string | undefined): void {
	defaultBroadcastChannel = channel;
}

export function registerClusterCommands(pi: ExtensionAPI): void {
	pi.registerCommand("cluster", {
		description: "Cluster commands: send, broadcast, who, status, services, sync-memory, reelect, stepdown, close",
		handler: async (args, ctx) => {
			const sub = parseSubcommand(args);

			switch (sub.cmd) {
				case "send": {
					const bus = resolveClusterBusHandle();
					if (!bus) {
						notify(ctx, "Bus not connected. Is the cluster running?", "warning");
						return;
					}
					if (!sub.target || !sub.body) {
						notify(ctx, "Usage: /cluster send <agentId> <message>", "warning");
						return;
					}
					try {
						const { agentId, displayName } = await bus.resolveTarget(sub.target);
						const privateChannel = `private:${agentId}`;
						const { seq } = await bus.broadcast(
							{ text: sub.body },
							privateChannel,
						);
						const label = displayName?.trim() ? `${displayName} (${agentId})` : agentId;
						notify(ctx, `→ [seq=${seq}] sent to ${label} via ${privateChannel}`, "info");
					} catch (err) {
						notify(ctx, `send failed: ${(err as Error).message}`, "error");
					}
					break;
				}

				case "broadcast": {
					const bus = resolveClusterBusHandle();
					if (!bus) {
						notify(ctx, "Bus not connected. Is the cluster running?", "warning");
						return;
					}
					if (!sub.body) {
						notify(ctx, "Usage: /cluster broadcast <message>", "warning");
						return;
					}
					try {
						const { seq, delivered } = await bus.broadcast(
							{ text: sub.body },
							sub.channel ?? defaultBroadcastChannel,
						);
						const ch = sub.channel ?? defaultBroadcastChannel ?? "public";
						notify(ctx, `→ [seq=${seq}] broadcast to ${ch} (${delivered} recipients)`, "info");
					} catch (err) {
						notify(ctx, `broadcast failed: ${(err as Error).message}`, "error");
					}
					break;
				}

				case "who": {
					const bus = resolveClusterBusHandle();
					if (!bus) {
						notify(ctx, "Bus not connected. Is the cluster running?", "warning");
						return;
					}
					try {
						const { agents } = await bus.roster();
						if (agents.length === 0) {
							notify(ctx, "No agents connected", "info");
						} else {
							const lines = agents.map((a) => {
								const name = a.displayName?.trim();
								const label = name ? `${name} (${a.agentId})` : a.agentId;
								const roleTag = a.role === "leader" ? "[leader]" : "[follower]";
								return `  ${roleTag} ${label}  [${a.channels.join(", ")}]`;
							});
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
							const text =
								typeof m.payload === "object" && m.payload !== null && "text" in m.payload
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

				case "status": {
					const activeV2 = getActiveClusterV2Service();
					if (activeV2) {
						const lines = [
							"cluster: v2",
							`role: ${activeV2.role}`,
							`bus: ${activeV2.bus ? "connected" : "disconnected"}`,
							`embedding: ${activeV2.embedding.id} (${activeV2.embedding.model})`,
						];
						notify(ctx, lines.join("\n"), "info");
						break;
					}

					const activeV1 = getActiveClusterService();
					if (activeV1) {
						const lines = [
							"cluster: v1",
							`role: ${activeV1.role}`,
							`bus: ${activeV1.bus ? "connected" : "disconnected"}`,
							`embedding: ${activeV1.embedding.id} (${activeV1.embedding.model})`,
						];
						notify(ctx, lines.join("\n"), "info");
						break;
					}

					notify(ctx, "Cluster not initialized", "warning");
					break;
				}

				case "services": {
					const activeV2 = getActiveClusterV2Service();
					if (!activeV2) {
						if (getActiveClusterService()) {
							notify(ctx, "services is currently available only for cluster_v2", "warning");
							break;
						}
						notify(ctx, "Cluster not initialized", "warning");
						break;
					}

					try {
						const snapshot = await activeV2.getServiceRegistrySnapshot();
						if (snapshot.services.length === 0) {
							notify(ctx, `cluster_v2 services: revision=${snapshot.revision}, no services`, "info");
							break;
						}

						const lines = snapshot.services.map((service) => {
							const capabilities = service.capabilities;
							const methodsValue =
								typeof capabilities === "object" && capabilities !== null
									? (capabilities as { methods?: unknown }).methods
									: undefined;
							const methods = Array.isArray(methodsValue)
								? methodsValue.filter((method): method is string => typeof method === "string")
								: [];
							const methodsText = methods.length > 0 ? methods.join(", ") : "none";
							return `  ${service.name}@${service.version} methods=[${methodsText}]`;
						});
						notify(
							ctx,
							`cluster_v2 services (revision=${snapshot.revision}):\n${lines.join("\n")}`,
							"info",
						);
					} catch (err) {
						notify(ctx, `services failed: ${(err as Error).message}`, "error");
					}
					break;
				}

				case "sync-memory": {
					const parsed = parseSyncMemoryArgs(sub.body ?? "");
					if (parsed.error) {
						notifyMemory(ctx, parsed.error, "warning");
						break;
					}

					if (parsed.mode && !isValidBuildMode(parsed.mode)) {
						notifyMemory(ctx, `Invalid --mode: ${parsed.mode}. ${SYNC_MEMORY_USAGE}`, "warning");
						break;
					}

					const mode: BuildMode = isValidBuildMode(parsed.mode) ? parsed.mode : "dirty";
					notifyMemory(ctx, `Building memory index (mode=${mode})...`, "info");

					try {
						const result = await buildMemoryIndex({
							workspaceDir: ctx.cwd,
							mode,
						});

						if (result.ok) {
							notifyMemory(ctx, result.message, "info");
						} else {
							notifyMemory(ctx, result.message, "warning");
						}
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						notifyMemory(ctx, `sync-memory failed: ${message}`, "error");
					}

					break;
				}

				case "reelect": {
					const activeV2 = getActiveClusterV2Service();
					if (!activeV2) {
						if (getActiveClusterService()) {
							notify(ctx, "reelect is currently available only for cluster_v2", "warning");
							break;
						}
						notify(ctx, "Cluster not initialized", "warning");
						break;
					}

					const previousRole = activeV2.role;
					try {
						const next = await reelectClusterV2();
						notify(
							ctx,
							`cluster_v2 reelect complete: ${previousRole} -> ${next.role}`,
							"info",
						);
					} catch (err) {
						notify(ctx, `reelect failed: ${(err as Error).message}`, "error");
					}
					break;
				}

				case "stepdown": {
					const activeV2 = getActiveClusterV2Service();
					if (!activeV2) {
						if (getActiveClusterService()) {
							notify(ctx, "stepdown is currently available only for cluster_v2", "warning");
							break;
						}
						notify(ctx, "Cluster not initialized", "warning");
						break;
					}
					if (activeV2.role !== "leader") {
						notify(ctx, `stepdown requires leader role, current role: ${activeV2.role}`, "warning");
						break;
					}

					try {
						const next = await stepdownClusterV2Leader();
						notify(
							ctx,
							`cluster_v2 stepdown complete: leader -> ${next.role}`,
							"info",
						);
					} catch (err) {
						notify(ctx, `stepdown failed: ${(err as Error).message}`, "error");
					}
					break;
				}

				case "close": {
					const activeV2 = getActiveClusterV2Service();
					if (activeV2) {
						try {
							const role = activeV2.role;
							await closeClusterV2();
							notify(ctx, `cluster_v2 closed (previous role: ${role})`, "info");
						} catch (err) {
							notify(ctx, `close failed: ${(err as Error).message}`, "error");
						}
						break;
					}

					const activeV1 = getActiveClusterService();
					if (activeV1) {
						try {
							const role = activeV1.role;
							await closeCluster();
							notify(ctx, `cluster_v1 closed (previous role: ${role})`, "info");
						} catch (err) {
							notify(ctx, `close failed: ${(err as Error).message}`, "error");
						}
						break;
					}

					notify(ctx, "Cluster not initialized", "warning");
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
	target?: string; // for send
	channel?: string; // for broadcast:<channel>
	body?: string;
}

function parseSyncMemoryArgs(raw: string): { mode?: string; error?: string } {
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
		return { error: `Unknown argument: ${token}. ${SYNC_MEMORY_USAGE}` };
	}

	return { mode };
}

function isValidBuildMode(value: string | undefined): value is BuildMode {
	return value === "full" || value === "dirty";
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
	if (level !== "info") {
		publishSystemEvent({
			source: "cluster",
			level,
			message,
			toast: false,
			ctx,
		});
	}

	if (ctx.hasUI && ctx.ui?.notify) {
		ctx.ui.notify(message, level);
	} else {
		const prefix = level === "error" ? "[error]" : level === "warning" ? "[warn]" : "[info]";
		console.log(`${prefix} ${message}`);
	}
}

function notifyMemory(
	ctx: { hasUI?: boolean; ui?: { notify?: (msg: string, level?: NotifyLevel) => void } },
	message: string,
	level: NotifyLevel,
): void {
	publishSystemEvent({
		source: "memory",
		level,
		message,
		toast: false,
		ctx,
	});

	if (ctx.hasUI && ctx.ui?.notify) {
		ctx.ui.notify(message, level);
	} else {
		const prefix = level === "error" ? "[error]" : level === "warning" ? "[warn]" : "[info]";
		console.log(`${prefix} ${message}`);
	}
}
