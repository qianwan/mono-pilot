import type {
	BroadcastParams,
	ClusterRpcClient,
	MessagePushPayload,
	PresencePushPayload,
	RegisterParams,
	RpcConnection,
	RpcRequestHandler,
	SendParams,
	SubscribeParams,
} from "../rpc.js";
import { createClusterLogContext, logClusterEvent } from "../observability.js";

export interface BusHandle {
	send(to: string, payload: unknown, channel?: string): Promise<{ seq: number }>;
	broadcast(payload: unknown, channel?: string): Promise<{ seq: number; delivered: number }>;
	subscribe(channels: string[]): Promise<{ channels: string[] }>;
	roster(): Promise<{
		agents: Array<{
			agentId: string;
			displayName?: string;
			role: "leader" | "follower";
			channels: string[];
		}>;
	}>;
	resolveTarget(target: string): Promise<{ agentId: string; displayName?: string }>;
	onMessage(handler: MessageHandler): void;
	onPresence(handler: PresenceHandler): void;
	close(): void;
}

export type MessageHandler = (msg: MessagePushPayload) => void;
export type PresenceHandler = (event: PresencePushPayload) => void;

export const BUS_METHOD_REGISTER = "bus.register";
export const BUS_METHOD_SUBSCRIBE = "bus.subscribe";
export const BUS_METHOD_SEND = "bus.send";
export const BUS_METHOD_BROADCAST = "bus.broadcast";
export const BUS_METHOD_ROSTER = "bus.roster";

const CONNECTION_AGENT_ID_KEY = "bus.agentId";

type PushFn = (method: string, payload: unknown) => void;

interface ConnectedAgent {
	agentId: string;
	displayName?: string;
	role: "leader" | "follower";
	push: PushFn;
	channels: Set<string>;
	connection?: RpcConnection;
}

interface RegisterAgentResult {
	channels: string[];
	previousRole: "leader" | "follower" | null;
	nextRole: "leader" | "follower";
	roleDowngradePrevented: boolean;
}

export interface BusService {
	handlers: Record<string, RpcRequestHandler>;
	onConnectionClosed(connection: RpcConnection): void;
	createLeaderHandle(agentId: string, displayName?: string): BusHandle;
}

function parseRegisterParams(params: unknown): RegisterParams {
	if (!params || typeof params !== "object") {
		throw new Error("bus.register requires object params");
	}
	const p = params as RegisterParams;
	if (!p.agentId || typeof p.agentId !== "string") {
		throw new Error("bus.register requires string agentId");
	}
	if (p.channels && (!Array.isArray(p.channels) || p.channels.some((c) => typeof c !== "string"))) {
		throw new Error("bus.register channels must be string[]");
	}
	if (p.displayName !== undefined && typeof p.displayName !== "string") {
		throw new Error("bus.register displayName must be string");
	}
	return p;
}

function parseSubscribeParams(params: unknown): SubscribeParams {
	if (!params || typeof params !== "object") {
		throw new Error("bus.subscribe requires object params");
	}
	const p = params as SubscribeParams;
	if (!Array.isArray(p.channels) || p.channels.some((c) => typeof c !== "string")) {
		throw new Error("bus.subscribe requires string[] channels");
	}
	return p;
}

function parseSendParams(params: unknown): SendParams {
	if (!params || typeof params !== "object") {
		throw new Error("bus.send requires object params");
	}
	const p = params as SendParams;
	if (!p.to || typeof p.to !== "string") {
		throw new Error("bus.send requires string to");
	}
	if (p.channel !== undefined && typeof p.channel !== "string") {
		throw new Error("bus.send channel must be string");
	}
	return p;
}

function parseBroadcastParams(params: unknown): BroadcastParams {
	if (!params || typeof params !== "object") {
		throw new Error("bus.broadcast requires object params");
	}
	const p = params as BroadcastParams;
	if (p.channel !== undefined && typeof p.channel !== "string") {
		throw new Error("bus.broadcast channel must be string");
	}
	return p;
}

export function createBusService(): BusService {
	const agents = new Map<string, ConnectedAgent>();
	let messageSeq = 0;

	const getDefaultChannels = (agentId: string): string[] => ["public", `private:${agentId}`];

	const broadcastPresence = (agentId: string, status: "joined" | "left", exclude?: string) => {
		const payload: PresencePushPayload = {
			agentId,
			displayName: agents.get(agentId)?.displayName,
			status,
		};
		for (const [id, agent] of agents) {
			if (id === exclude) continue;
			agent.push("presence", payload);
		}
	};

	const registerAgent = (
		agentId: string,
		push: PushFn,
		role: "leader" | "follower",
		channels?: string[],
		displayName?: string,
		connection?: RpcConnection,
	): RegisterAgentResult => {
		const existing = agents.get(agentId);
		const previousRole = existing?.role ?? null;
		const roleDowngradePrevented = existing?.role === "leader" && role === "follower";

		if (existing && roleDowngradePrevented) {
			const allChannels = [...new Set([...existing.channels, ...getDefaultChannels(agentId), ...(channels ?? [])])];
			agents.set(agentId, {
				agentId,
				displayName: existing.displayName ?? displayName,
				role: existing.role,
				push: existing.push,
				channels: new Set(allChannels),
				connection: existing.connection,
			});
			return {
				channels: allChannels,
				previousRole,
				nextRole: existing.role,
				roleDowngradePrevented,
			};
		}

		if (existing) {
			existing.push = () => {
				// old connection is superseded by the new registration.
			};
		}

		const allChannels = [...new Set([...getDefaultChannels(agentId), ...(channels ?? [])])];
		agents.set(agentId, {
			agentId,
			displayName,
			role,
			push,
			channels: new Set(allChannels),
			connection,
		});

		broadcastPresence(agentId, "joined", agentId);
		for (const [id, current] of agents) {
			if (id === agentId) continue;
			push("presence", {
				agentId: id,
				displayName: current.displayName,
				status: "joined",
			} satisfies PresencePushPayload);
		}

		return {
			channels: allChannels,
			previousRole,
			nextRole: role,
			roleDowngradePrevented,
		};
	};

	const unregisterAgent = (agentId: string) => {
		if (!agents.has(agentId)) return;
		agents.delete(agentId);
		broadcastPresence(agentId, "left");
	};

	const senderFromConnection = (connection: RpcConnection): string => {
		const sender = connection.state.get(CONNECTION_AGENT_ID_KEY);
		if (!sender || typeof sender !== "string") {
			throw new Error("must register before calling bus method");
		}
		return sender;
	};

	const handlers: Record<string, RpcRequestHandler> = {
		[BUS_METHOD_REGISTER]: async (request, connection) => {
			const { agentId, channels, displayName } = parseRegisterParams(request.params);
			const registration = registerAgent(
				agentId,
				(method, payload) => connection.sendPush(method, payload),
				"follower",
				channels,
				displayName,
				connection,
			);
			const fromSessionId = request.from?.sessionId;
			logClusterEvent(
				registration.roleDowngradePrevented ? "warn" : "info",
				registration.roleDowngradePrevented
					? "bus_register_role_downgrade_prevented"
					: "bus_register",
				createClusterLogContext({
					agentId,
					sessionId: fromSessionId,
					role: "leader:bus",
				}),
				{
					previousRole: registration.previousRole,
					nextRole: registration.nextRole,
					requestedRole: "follower",
					fromPid: request.from?.pid ?? null,
					fromSessionId: fromSessionId ?? null,
					fromAgentId: request.from?.agentId ?? null,
					channels: registration.channels,
				},
			);
			connection.state.set(CONNECTION_AGENT_ID_KEY, agentId);
			return { agentId, channels: registration.channels };
		},

		[BUS_METHOD_SUBSCRIBE]: async (request, connection) => {
			const sender = senderFromConnection(connection);
			const { channels } = parseSubscribeParams(request.params);
			const agent = agents.get(sender);
			if (!agent) {
				throw new Error("registered agent not found");
			}
			for (const channel of channels) {
				agent.channels.add(channel);
			}
			return { channels: [...agent.channels] };
		},

		[BUS_METHOD_SEND]: async (request, connection) => {
			const sender = senderFromConnection(connection);
			const { to, channel, payload } = parseSendParams(request.params);
			const target = agents.get(to);
			if (!target) {
				throw new Error(`agent not found: ${to}`);
			}
			const seq = ++messageSeq;
			target.push("message", {
				from: sender,
				fromName: agents.get(sender)?.displayName,
				channel,
				payload,
				seq,
			} satisfies MessagePushPayload);
			return { seq };
		},

		[BUS_METHOD_BROADCAST]: async (request, connection) => {
			const sender = senderFromConnection(connection);
			const { channel, payload } = parseBroadcastParams(request.params);
			const targetChannel = channel ?? "public";
			const seq = ++messageSeq;
			let delivered = 0;
			const pushPayload: MessagePushPayload = {
				from: sender,
				fromName: agents.get(sender)?.displayName,
				channel: targetChannel,
				payload,
				seq,
			};
			for (const [id, agent] of agents) {
				if (id === sender) continue;
				if (agent.channels.has(targetChannel)) {
					agent.push("message", pushPayload);
					delivered++;
				}
			}
			return { seq, delivered };
		},

		[BUS_METHOD_ROSTER]: async () => {
			return {
				agents: [...agents.entries()].map(([id, agent]) => ({
					agentId: id,
					displayName: agent.displayName,
					role: agent.role,
					channels: [...agent.channels],
				})),
			};
		},
	};

	const onConnectionClosed = (connection: RpcConnection) => {
		const agentId = connection.state.get(CONNECTION_AGENT_ID_KEY);
		if (!agentId || typeof agentId !== "string") {
			return;
		}
		const current = agents.get(agentId);
		if (current?.connection !== connection) {
			return;
		}
		unregisterAgent(agentId);
	};

	const createLeaderHandle = (agentId: string, displayName?: string): BusHandle => {
		let closed = false;
		let messageHandlers: MessageHandler[] = [];
		let presenceHandlers: PresenceHandler[] = [];

		const push: PushFn = (method, payload) => {
			if (closed) return;
			if (method === "message") {
				for (const handler of messageHandlers) {
					handler(payload as MessagePushPayload);
				}
				return;
			}
			if (method === "presence") {
				for (const handler of presenceHandlers) {
					handler(payload as PresencePushPayload);
				}
			}
		};

		registerAgent(agentId, push, "leader", undefined, displayName, undefined);

		return {
			async send(to, payload, channel) {
				const target = agents.get(to);
				if (!target) {
					throw new Error(`agent not found: ${to}`);
				}
				const seq = ++messageSeq;
				target.push("message", {
					from: agentId,
					fromName: agents.get(agentId)?.displayName,
					channel,
					payload,
					seq,
				} satisfies MessagePushPayload);
				return { seq };
			},

			async broadcast(payload, channel) {
				const targetChannel = channel ?? "public";
				const seq = ++messageSeq;
				let delivered = 0;
				const pushPayload: MessagePushPayload = {
					from: agentId,
					fromName: agents.get(agentId)?.displayName,
					channel: targetChannel,
					payload,
					seq,
				};
				for (const [id, agent] of agents) {
					if (id === agentId) continue;
					if (agent.channels.has(targetChannel)) {
						agent.push("message", pushPayload);
						delivered++;
					}
				}
				return { seq, delivered };
			},

			async subscribe(channels) {
				const agent = agents.get(agentId);
				if (!agent) return { channels: [] };
				for (const channel of channels) {
					agent.channels.add(channel);
				}
				return { channels: [...agent.channels] };
			},

			async roster() {
				return {
					agents: [...agents.entries()].map(([id, agent]) => ({
						agentId: id,
						displayName: agent.displayName,
						role: agent.role,
						channels: [...agent.channels],
					})),
				};
			},

			async resolveTarget(target) {
				const { agents: roster } = await this.roster();
				const byId = roster.find((agent) => agent.agentId === target);
				if (byId) return { agentId: byId.agentId, displayName: byId.displayName };

				const matches = roster.filter(
					(agent) => agent.displayName?.trim() && agent.displayName.trim() === target,
				);
				if (matches.length === 1) {
					return { agentId: matches[0].agentId, displayName: matches[0].displayName };
				}
				if (matches.length === 0) {
					throw new Error(`No agent found for "${target}".`);
				}
				const ids = matches.map((agent) => agent.agentId).join(", ");
				throw new Error(`DisplayName "${target}" is not unique. Candidates: ${ids}.`);
			},

			onMessage(handler) {
				messageHandlers.push(handler);
			},

			onPresence(handler) {
				presenceHandlers.push(handler);
			},

			close() {
				if (closed) return;
				closed = true;
				messageHandlers = [];
				presenceHandlers = [];
				unregisterAgent(agentId);
			},
		};
	};

	return {
		handlers,
		onConnectionClosed,
		createLeaderHandle,
	};
}

export async function connectBusClient(
	client: ClusterRpcClient,
	agentId: string,
	displayName?: string,
	channels?: string[],
): Promise<BusHandle> {
	let closed = false;
	let buffering = true;
	const eventBuffer: Array<{ method: string; payload: unknown }> = [];
	let messageHandlers: MessageHandler[] = [];
	let presenceHandlers: PresenceHandler[] = [];

	const dispatch = (method: string, payload: unknown) => {
		if (method === "message") {
			for (const handler of messageHandlers) {
				handler(payload as MessagePushPayload);
			}
			return;
		}
		if (method === "presence") {
			for (const handler of presenceHandlers) {
				handler(payload as PresencePushPayload);
			}
		}
	};

	const unbindMessage = client.onPush("message", (payload) => {
		if (closed) return;
		if (buffering) {
			eventBuffer.push({ method: "message", payload });
			return;
		}
		dispatch("message", payload);
	});

	const unbindPresence = client.onPush("presence", (payload) => {
		if (closed) return;
		if (buffering) {
			eventBuffer.push({ method: "presence", payload });
			return;
		}
		dispatch("presence", payload);
	});

	await client.call(BUS_METHOD_REGISTER, {
		agentId,
		displayName,
		channels,
	} satisfies RegisterParams);

	process.nextTick(() => {
		buffering = false;
		for (const evt of eventBuffer) {
			dispatch(evt.method, evt.payload);
		}
		eventBuffer.length = 0;
	});

	const roster = async () => {
		return client.call<{
			agents: Array<{
				agentId: string;
				displayName?: string;
				role: "leader" | "follower";
				channels: string[];
			}>;
		}>(
			BUS_METHOD_ROSTER,
			{},
		);
	};

	return {
		async send(to, payload, channel) {
			return client.call<{ seq: number }>(BUS_METHOD_SEND, {
				to,
				channel,
				payload,
			} satisfies SendParams);
		},

		async broadcast(payload, channel) {
			return client.call<{ seq: number; delivered: number }>(BUS_METHOD_BROADCAST, {
				channel,
				payload,
			} satisfies BroadcastParams);
		},

		async subscribe(chs) {
			return client.call<{ channels: string[] }>(BUS_METHOD_SUBSCRIBE, { channels: chs } satisfies SubscribeParams);
		},

		roster,

		async resolveTarget(target) {
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
				throw new Error(`No agent found for "${target}".`);
			}
			const ids = matches.map((agent) => agent.agentId).join(", ");
			throw new Error(`DisplayName "${target}" is not unique. Candidates: ${ids}.`);
		},

		onMessage(handler) {
			messageHandlers.push(handler);
		},

		onPresence(handler) {
			presenceHandlers.push(handler);
		},

		close() {
			if (closed) return;
			closed = true;
			messageHandlers = [];
			presenceHandlers = [];
			eventBuffer.length = 0;
			unbindMessage();
			unbindPresence();
		},
	};
}
