/**
 * High-level message bus API over the cluster socket.
 *
 * Wraps ClusterClient RPC + push into a simple event-driven interface.
 * Socket lifecycle is owned by FollowerHandle — bus only manages messaging.
 */

import type { ClusterClient } from "./follower.js";
import type {
	RegisterParams,
	SendParams,
	BroadcastParams,
	SubscribeParams,
	MessagePushPayload,
	PresencePushPayload,
} from "./protocol.js";
import { clusterLog } from "./log.js";

export interface BusHandle {
	/** Send a direct message to a specific agent. */
	send(to: string, payload: unknown, channel?: string): Promise<{ seq: number }>;
	/** Broadcast to all subscribers of a channel (default: "public"). */
	broadcast(payload: unknown, channel?: string): Promise<{ seq: number; delivered: number }>;
	/** Subscribe to additional channels. */
	subscribe(channels: string[]): Promise<{ channels: string[] }>;
	/** List all connected agents. */
	roster(): Promise<{ agents: Array<{ agentId: string; displayName?: string; channels: string[] }> }>;
	/** Resolve displayName or agentId to an agentId. */
	resolveTarget(target: string): Promise<{ agentId: string; displayName?: string }>;
	/** Register a handler for incoming messages from other agents. */
	onMessage(handler: MessageHandler): void;
	/** Register a handler for presence events (agent joined/left). */
	onPresence(handler: PresenceHandler): void;
	/** Detach from the bus (unregisters push handlers, does not close socket). */
	close(): void;
}

export type MessageHandler = (msg: MessagePushPayload) => void;
export type PresenceHandler = (event: PresencePushPayload) => void;

/**
 * Connect to the cluster message bus.
 *
 * Calls `register` on the leader, wires push dispatch, returns a BusHandle.
 * The underlying socket is owned by the FollowerHandle — call bus.close()
 * to detach messaging without killing the embedding connection.
 */
export async function connectBus(
	client: ClusterClient,
	agentId: string,
	displayName?: string,
	channels?: string[],
): Promise<BusHandle> {
	let messageHandlers: MessageHandler[] = [];
	let presenceHandlers: PresenceHandler[] = [];
	let closed = false;
	const eventBuffer: Array<{ method: string; payload: unknown }> = [];
	let buffering = true;

	function dispatch(method: string, payload: unknown): void {
		switch (method) {
			case "message": {
				const msg = payload as MessagePushPayload;
				for (const h of messageHandlers) h(msg);
				break;
			}
			case "presence": {
				const evt = payload as PresencePushPayload;
				for (const h of presenceHandlers) h(evt);
				break;
			}
			default:
				clusterLog.debug("unknown push method", { method });
		}
	}

	// Wire push handler BEFORE register so presence events for existing agents are captured
	client.onPush((method, payload) => {
		if (closed) return;
		if (buffering) {
			eventBuffer.push({ method, payload });
			return;
		}
		dispatch(method, payload);
	});

	const result = await client.call<{ agentId: string; channels: string[] }>(
		"register",
		{ agentId, displayName, channels } satisfies RegisterParams,
	);
	clusterLog.info("bus connected", { agentId: result.agentId, channels: result.channels });

	// Flush buffered events on next tick — gives caller time to register handlers synchronously
	process.nextTick(() => {
		buffering = false;
		for (const evt of eventBuffer) dispatch(evt.method, evt.payload);
		eventBuffer.length = 0;
	});

	const roster = async () => {
		return client.call<{ agents: Array<{ agentId: string; displayName?: string; channels: string[] }> }>(
			"roster",
			{},
		);
	};

	const resolveTarget = async (target: string) => {
		const { agents } = await roster();
		const byId = agents.find((agent) => agent.agentId === target);
		if (byId) return { agentId: byId.agentId, displayName: byId.displayName };

		const matches = agents.filter(
			(agent) => agent.displayName?.trim() && agent.displayName.trim() === target,
		);
		if (matches.length === 1) {
			return { agentId: matches[0].agentId, displayName: matches[0].displayName };
		}

		if (matches.length === 0) {
			throw new Error(`No agent found for "${target}". Use /bus who to list agents.`);
		}

		const ids = matches.map((agent) => agent.agentId).join(", ");
		throw new Error(
			`DisplayName "${target}" is not unique. Candidates: ${ids}. Use agentId instead.`,
		);
	};

	return {
		async send(to, payload, channel) {
			return client.call<{ seq: number }>(
				"send",
				{ to, channel, payload } satisfies SendParams,
			);
		},

		async broadcast(payload, channel) {
			return client.call<{ seq: number; delivered: number }>(
				"broadcast",
				{ channel, payload } satisfies BroadcastParams,
			);
		},

		async subscribe(chs) {
			return client.call<{ channels: string[] }>(
				"subscribe",
				{ channels: chs } satisfies SubscribeParams,
			);
		},

		roster,
		resolveTarget,

		onMessage(handler) {
			messageHandlers.push(handler);
		},

		onPresence(handler) {
			presenceHandlers.push(handler);
		},

		close() {
			closed = true;
			messageHandlers = [];
			presenceHandlers = [];
			client.onPush(() => {});
			clusterLog.debug("bus detached", { agentId });
		},
	};
}