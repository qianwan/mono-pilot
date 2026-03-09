/**
 * Subsystem orchestration: init and shutdown for LSP, Cluster, Memory, and Bus.
 *
 * Dependency order:
 *   init:     LSP → Cluster → Memory (uses Cluster embedding) → Bus (uses Cluster socket)
 *   shutdown: Bus → Memory → Cluster (LSP has no shutdown)
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { LSP } from "../lsp/index.js";
import { deriveAgentId } from "../agents-paths.js";
import { loadResolvedMemorySearchConfig } from "../memory/config/loader.js";
import { initCluster, closeCluster, type ClusterService } from "../cluster/init.js";
import {
	getActiveClusterV2Service,
	initClusterV2,
	closeClusterV2,
	onClusterV2DiscordChannelBatch,
	onClusterV2LeaderOffline,
	onClusterV2LeaderRecovered,
	type ClusterV2DiscordChannelBatchEvent,
	type ClusterV2Service,
} from "../cluster_v2/index.js";
import { setMemoryWorkersEmbeddingProvider, closeMemorySearchManagers } from "../memory/runtime/index.js";
import { warmMemorySearch } from "../memory/warm.js";
import type { BusHandle } from "../cluster/bus.js";
import { setMailBoxHandle } from "./game/mailbox.js";
import type { MessagePushPayload } from "../cluster/protocol.js";
import { publishSystemEvent } from "./system-events.js";

let activeClusterVersion: "v1" | "v2" | null = null;

export interface SubsystemHandles {
	bus: BusHandle | null;
	dispose?: () => void;
}

export interface SubsystemOptions {
	displayName?: string;
	busChannels?: string[];
	busMessageFilter?: (msg: MessagePushPayload) => boolean;
	busMessageInjector?: (msg: MessagePushPayload) => void;
}

/**
 * Initialize all subsystems. Fire-and-forget from session_start.
 */
export async function initSubsystems(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options?: SubsystemOptions,
): Promise<SubsystemHandles> {
	const agentId = deriveAgentId(ctx.cwd);
	const sessionManager = (ctx as any).sessionManager;
	const getSessionId = () => sessionManager?.getSessionId?.() ?? "unknown";

	// 1. LSP
	LSP.init(ctx.cwd);

	// 2. Cluster + 3. Memory (cluster provides embedding for memory)
	const settings = await loadResolvedMemorySearchConfig();
	let cluster: ClusterService | ClusterV2Service | null = null;
	const useClusterV2 =
		process.env.MONO_PILOT_CLUSTER_VERSION === "2" || process.env.MONO_PILOT_CLUSTER_V2 === "1";

	if (settings.enabled && settings.provider === "local") {
		if (useClusterV2) {
			cluster = await initClusterV2({
				...settings.local,
				agentId,
				displayName: options?.displayName,
				getSessionId,
			});
			activeClusterVersion = "v2";
		} else {
			cluster = await initCluster({
				...settings.local,
				agentId,
				displayName: options?.displayName,
				getSessionId,
			});
			activeClusterVersion = "v1";
		}
		setMemoryWorkersEmbeddingProvider(cluster.embedding);
	}

	if (settings.enabled && settings.sync.onSessionStart) {
		startMemoryWarmupInBackground(ctx, { workspaceDir: ctx.cwd, agentId });
	}

	// 4. Bus (message injection into agent conversation)
	const bus = cluster?.bus ?? null;
	const disposers: Array<() => void> = [];

	if (activeClusterVersion === "v2") {
		disposers.push(
			onClusterV2DiscordChannelBatch((event) => {
				publishDiscordChannelBatchSystemEvent(ctx, event);
			}),
		);
		disposers.push(
			onClusterV2LeaderOffline(() => {
				publishSystemEvent({
					source: "cluster",
					level: "warning",
					message: "Leader offline. Re-election in progress.",
					dedupeKey: "cluster|leader_offline",
					toast: false,
					ctx,
				});
			}),
		);
		disposers.push(
			onClusterV2LeaderRecovered(() => {
				void publishClusterV2LeaderRecoveredEvent(ctx);
			}),
		);
	}

	if (bus) {
		if (options?.busChannels && options.busChannels.length > 0) {
			await bus.subscribe(options.busChannels);
		}

		const filter = options?.busMessageFilter;
		const injector = options?.busMessageInjector ?? createDefaultBusMessageInjector(pi);
		bus.onMessage((msg) => {
			if (filter && !filter(msg)) return;
			injector(msg);
		});
	}
	setMailBoxHandle(bus ?? null);
	const dispose =
		disposers.length > 0
			? () => {
				for (const fn of [...disposers].reverse()) {
					fn();
				}
			}
			: undefined;

	return { bus, dispose };
}

/**
 * Shutdown all subsystems in reverse dependency order.
 */
export async function shutdownSubsystems(handles: SubsystemHandles | null): Promise<void> {
	try {
		handles?.dispose?.();
		// Bus
		if (handles?.bus) handles.bus.close();
		setMailBoxHandle(null);
		// Memory
		await closeMemorySearchManagers();
		// Cluster
		if (activeClusterVersion === "v2") {
			await closeClusterV2();
		} else {
			await closeCluster();
		}
		activeClusterVersion = null;
	} catch (err) {
		console.warn(`[subsystems] shutdown failed: ${String(err)}`);
	}
}

interface LeaderAgent {
	agentId: string;
	displayName?: string;
	role: "leader" | "follower";
	channels: string[];
}

function formatLeaderLabel(leader: LeaderAgent): string {
	const name = leader.displayName?.trim();
	return name ? `${name} (${leader.agentId})` : leader.agentId;
}

function buildLeaderKey(leaders: LeaderAgent[]): string {
	return leaders
		.map((leader) => leader.agentId)
		.sort()
		.join(",");
}

function buildLeaderLabel(leaders: LeaderAgent[]): string {
	return leaders.map((leader) => formatLeaderLabel(leader)).join(", ");
}

async function publishClusterV2LeaderRecoveredEvent(ctx: ExtensionContext): Promise<void> {
	const active = getActiveClusterV2Service();
	const bus = active?.bus ?? null;
	if (!bus) {
		publishSystemEvent({
			source: "cluster",
			level: "info",
			message: "Re-election complete.",
			dedupeKey: "cluster|leader_elected",
			toast: true,
			ctx,
		});
		return;
	}

	try {
		const roster = await bus.roster();
		const leaders = (roster.agents as LeaderAgent[]).filter((agent) => agent.role === "leader");
		if (leaders.length === 0) {
			publishSystemEvent({
				source: "cluster",
				level: "info",
				message: "Re-election complete.",
				dedupeKey: "cluster|leader_elected",
				toast: true,
				ctx,
			});
			return;
		}

		const leaderKey = buildLeaderKey(leaders);
		const leaderLabel = buildLeaderLabel(leaders);
		publishSystemEvent({
			source: "cluster",
			level: "info",
			message: `Re-election complete. Leader: ${leaderLabel}.`,
			dedupeKey: `cluster|leader_elected|${leaderKey}`,
			toast: true,
			ctx,
		});
	} catch {
		publishSystemEvent({
			source: "cluster",
			level: "info",
			message: "Re-election complete.",
			dedupeKey: "cluster|leader_elected",
			toast: true,
			ctx,
		});
	}
}

function publishDiscordChannelBatchSystemEvent(
	ctx: ExtensionContext,
	event: ClusterV2DiscordChannelBatchEvent,
): void {
	const channelLabel =
		event.channelAlias?.trim() ||
		(event.guildName?.trim() && event.channelName?.trim()
			? `${event.guildName.trim()} / ${event.channelName.trim()}`
			: event.channelName?.trim()) ||
		event.channelId;

	publishSystemEvent({
		source: "discord",
		level: "info",
		message: `Channel ${channelLabel} collected ${event.count} messages.`,
		dedupeKey: `discord|channel_batch|${event.scope}|${event.channelId}|${event.sequence}`,
		toast: false,
		ctx,
	});
}

function startMemoryWarmupInBackground(
	ctx: ExtensionContext,
	params: { workspaceDir: string; agentId: string },
): void {
	let startNotified = false;
	const notifyWarmupStartIfNeeded = () => {
		if (startNotified) {
			return;
		}
		startNotified = true;
		publishSystemEvent({
			source: "memory",
			level: "info",
			message: "Memory warmup in progress.",
			dedupeKey: `memory|warmup|start|${params.agentId}`,
			toast: false,
			ctx,
		});
	};

	void warmMemorySearch({
		...params,
		onWorkDetected: notifyWarmupStartIfNeeded,
	})
		.then((result) => {
			if (!result.attempted || !startNotified) {
				return;
			}
			if (result.succeeded) {
				publishSystemEvent({
					source: "memory",
					level: "info",
					message: "Memory warmup complete.",
					dedupeKey: `memory|warmup|done|${params.agentId}`,
					toast: false,
					ctx,
				});
				return;
			}
			publishSystemEvent({
				source: "memory",
				level: "warning",
				message: `Memory warmup failed: ${result.error ?? "unknown error"}`,
				dedupeKey: `memory|warmup|failed|${params.agentId}`,
				toast: false,
				ctx,
			});
		})
		.catch((error) => {
			if (!startNotified) {
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			publishSystemEvent({
				source: "memory",
				level: "warning",
				message: `Memory warmup failed: ${message}`,
				dedupeKey: `memory|warmup|failed|${params.agentId}`,
				toast: false,
				ctx,
			});
		});
}

// --- Bus message injection (debounced) ---

function createDefaultBusMessageInjector(pi: ExtensionAPI): (msg: MessagePushPayload) => void {
	let pending: MessagePushPayload[] = [];
	let timer: ReturnType<typeof setTimeout> | null = null;

	function flush(): void {
		if (pending.length === 0) return;
		const msgs = pending;
		pending = [];
		timer = null;

		const lines = msgs.map((m) => {
			const text =
				typeof m.payload === "object" && m.payload !== null && "text" in m.payload
					? (m.payload as { text: string }).text
					: JSON.stringify(m.payload);
			const ch = m.channel && m.channel !== "public" ? ` [${m.channel}]` : "";
			return `[from ${m.from}${ch}] ${text}`;
		});

		const envelope =
			"<bus_messages>\n" + lines.join("\n") + "\n</bus_messages>\n\n" +
			"You received the above messages from other agents via the message bus. " +
			"Respond in character. Use the bus_send tool to reply.";

		pi.sendUserMessage(envelope, { deliverAs: "followUp" });
	}

	return (msg) => {
		pending.push(msg);
		if (timer) clearTimeout(timer);
		timer = setTimeout(flush, 300);
	};
}