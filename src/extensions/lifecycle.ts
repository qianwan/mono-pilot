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
	initClusterV2,
	closeClusterV2,
	type ClusterV2Service,
} from "../cluster_v2/index.js";
import { setMemoryWorkersEmbeddingProvider, closeMemorySearchManagers } from "../memory/runtime/index.js";
import { warmMemorySearch } from "../memory/warm.js";
import type { BusHandle } from "../cluster/bus.js";
import { setMailBoxHandle } from "./game/mailbox.js";
import type { MessagePushPayload } from "../cluster/protocol.js";

let activeClusterVersion: "v1" | "v2" | null = null;

export interface SubsystemHandles {
	bus: BusHandle | null;
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

	await warmMemorySearch({ workspaceDir: ctx.cwd, agentId });

	// 4. Bus (message injection into agent conversation)
	const bus = cluster?.bus ?? null;
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

	return { bus };
}

/**
 * Shutdown all subsystems in reverse dependency order.
 */
export async function shutdownSubsystems(handles: SubsystemHandles | null): Promise<void> {
	try {
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