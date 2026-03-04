/**
 * Message bus service handler for the cluster leader.
 * Manages agent route table, message routing, presence, and channel subscriptions.
 *
 * Also exports createLeaderBus() for in-process loopback (leader participates in bus
 * without going through a socket).
 */
import {
	encodeMessage,
	type ClusterPush,
	type RegisterParams,
	type SendParams,
	type BroadcastParams,
	type SubscribeParams,
	type MessagePushPayload,
	type PresencePushPayload,
} from "../protocol.js";
import type { ServiceHandler, RequestContext } from "../leader.js";
import type { BusHandle, MessageHandler, PresenceHandler } from "../bus.js";
import { clusterLog } from "../log.js";

// --- Route table (module-level singleton, lives with the leader process) ---

/** Delivers a push message to an agent (socket-based or in-process callback). */
type PushFn = (method: string, payload: unknown) => void;

interface ConnectedAgent {
	agentId: string;
	displayName?: string;
	push: PushFn;
	channels: Set<string>;
}

const agents = new Map<string, ConnectedAgent>();
let messageSeq = 0;

function broadcastPresence(agentId: string, status: "joined" | "left", exclude?: string): void {
	const payload: PresencePushPayload = { agentId, displayName: agents.get(agentId)?.displayName, status };
	for (const [id, agent] of agents) {
		if (id !== exclude) agent.push("presence", payload);
	}
}

function socketPush(socket: import("node:net").Socket): PushFn {
	return (method, payload) => {
		if (!socket.destroyed) {
			socket.write(encodeMessage({ type: "push", method, payload } satisfies ClusterPush));
		}
	};
}

function registerAgent(agentId: string, push: PushFn, channels?: string[], displayName?: string): string[] {
	const existing = agents.get(agentId);
	if (existing) existing.push = () => {};

	const defaultChannels = ["public", `private:${agentId}`];
	const allChannels = [...defaultChannels, ...(channels ?? [])];
	agents.set(agentId, { agentId, displayName, push, channels: new Set(allChannels) });
	clusterLog.info("agent registered", { agentId, channels: allChannels });

	broadcastPresence(agentId, "joined", agentId);
	for (const [id, existing] of agents) {
		if (id !== agentId) {
					push(
						"presence",
						{ agentId: id, displayName: existing.displayName, status: "joined" } satisfies PresencePushPayload,
					);
		}
	}
	return allChannels;
}

// --- ServiceHandler for follower RPC requests ---

export function createBusHandler(): ServiceHandler {
	return {
		methods: ["register", "subscribe", "send", "broadcast", "roster"],

		async handle(req, ctx) {
			switch (req.method) {
				case "register": {
					const { agentId, channels, displayName } = req.params as RegisterParams;
					if (!agentId) { ctx.respond({ error: "register requires agentId" }); return; }
					const allChannels = registerAgent(agentId, socketPush(ctx.socket), channels, displayName);
					ctx.setRegisteredId(agentId);
					ctx.respond({ result: { agentId, channels: allChannels } });
					return;
				}
				case "subscribe": {
					const registeredId = ctx.getRegisteredId();
					if (!registeredId) { ctx.respond({ error: "must register before subscribe" }); return; }
					const agent = agents.get(registeredId);
					if (!agent) { ctx.respond({ error: "agent not found in route table" }); return; }
					const { channels } = req.params as SubscribeParams;
					for (const ch of channels) agent.channels.add(ch);
					clusterLog.debug("subscribe", { agentId: registeredId, channels });
					ctx.respond({ result: { channels: [...agent.channels] } });
					return;
				}
				case "send": {
					const registeredId = ctx.getRegisteredId();
					if (!registeredId) { ctx.respond({ error: "must register before send" }); return; }
					const { to, channel, payload } = req.params as SendParams;
					const target = agents.get(to);
					if (!target) { ctx.respond({ error: `agent not found: ${to}` }); return; }
					const seq = ++messageSeq;
					target.push(
						"message",
						{
							from: registeredId,
							fromName: agents.get(registeredId)?.displayName,
							channel,
							payload,
							seq,
						} satisfies MessagePushPayload,
					);
					clusterLog.debug("send", { from: registeredId, to, seq });
					ctx.respond({ result: { seq } });
					return;
				}
				case "broadcast": {
					const registeredId = ctx.getRegisteredId();
					if (!registeredId) { ctx.respond({ error: "must register before broadcast" }); return; }
					const { channel, payload } = req.params as BroadcastParams;
					const targetChannel = channel ?? "public";
					const seq = ++messageSeq;
					const fromName = agents.get(registeredId)?.displayName;
					const pushPayload: MessagePushPayload = {
					from: registeredId,
					fromName,
					channel: targetChannel,
					payload,
					seq,
					};
					let delivered = 0;
					for (const [id, agent] of agents) {
						if (id === registeredId) continue;
						if (agent.channels.has(targetChannel)) {
							agent.push("message", pushPayload);
							delivered++;
						}
					}
					clusterLog.debug("broadcast", { from: registeredId, channel: targetChannel, seq, delivered });
					ctx.respond({ result: { seq, delivered } });
					return;
				}
				case "roster": {
					const roster = [...agents.entries()].map(([id, a]) => ({
						agentId: id,
						displayName: a.displayName,
						channels: [...a.channels],
					}));
					ctx.respond({ result: { agents: roster } });
					return;
				}
			}
		},

		onDisconnect(agentId) {
			clusterLog.info("follower left", { agentId });
			agents.delete(agentId);
			broadcastPresence(agentId, "left");
		},
	};
}

// --- Leader loopback: in-process BusHandle without socket ---

export function createLeaderBus(agentId: string, displayName?: string): BusHandle {
	let messageHandlers: MessageHandler[] = [];
	let presenceHandlers: PresenceHandler[] = [];
	let closed = false;

	const push: PushFn = (method, payload) => {
		if (closed) return;
		if (method === "message") {
			for (const h of messageHandlers) h(payload as MessagePushPayload);
		} else if (method === "presence") {
			for (const h of presenceHandlers) h(payload as PresencePushPayload);
		}
	};

	registerAgent(agentId, push, undefined, displayName);

	return {
		async send(to, payload, channel) {
			const target = agents.get(to);
			if (!target) throw new Error(`agent not found: ${to}`);
			const seq = ++messageSeq;
			target.push(
				"message",
				{ from: agentId, fromName: agents.get(agentId)?.displayName, channel, payload, seq } satisfies MessagePushPayload,
			);
			clusterLog.debug("send (leader)", { from: agentId, to, seq });
			return { seq };
		},
		async broadcast(payload, channel) {
			const targetChannel = channel ?? "public";
			const seq = ++messageSeq;
			const pushPayload: MessagePushPayload = {
				from: agentId,
				fromName: agents.get(agentId)?.displayName,
				channel: targetChannel,
				payload,
				seq,
			};
			let delivered = 0;
			for (const [id, agent] of agents) {
				if (id === agentId) continue;
				if (agent.channels.has(targetChannel)) {
					agent.push("message", pushPayload);
					delivered++;
				}
			}
			clusterLog.debug("broadcast (leader)", { from: agentId, channel: targetChannel, seq, delivered });
			return { seq, delivered };
		},
		async subscribe(chs) {
			const entry = agents.get(agentId);
			if (entry) for (const ch of chs) entry.channels.add(ch);
			return { channels: entry ? [...entry.channels] : [] };
		},
		async roster() {
			return {
				agents: [...agents.entries()].map(([id, a]) => ({
					agentId: id,
					displayName: a.displayName,
					channels: [...a.channels],
				})),
			};
		},
		async resolveTarget(target) {
			const { agents } = await this.roster();
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
		},
		onMessage(handler) { messageHandlers.push(handler); },
		onPresence(handler) { presenceHandlers.push(handler); },
		close() {
			closed = true;
			messageHandlers = [];
			presenceHandlers = [];
			agents.delete(agentId);
			broadcastPresence(agentId, "left");
			clusterLog.debug("leader bus closed", { agentId });
		},
	};
}