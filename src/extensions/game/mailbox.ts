import type { BusHandle } from "../../cluster/bus.js";
import type { MessagePushPayload } from "../../cluster/protocol.js";

interface MailBoxOptions {
	gmChannel?: string;
}

interface ReadOptions {
	limit?: number;
	clear?: boolean;
}

let activeBus: BusHandle | null = null;
let gmChannel: string | undefined;
let listenerInstalled = false;
const mailbox: MessagePushPayload[] = [];
const seenSeq = new Set<number>();
let roundGateSeq: number | null = null;

export function setMailBoxHandle(bus: BusHandle | null, options?: MailBoxOptions): void {
	activeBus = bus;
	gmChannel = options?.gmChannel;

	if (!bus) {
		listenerInstalled = false;
		mailbox.length = 0;
		roundGateSeq = null;
		return;
	}

	if (listenerInstalled) return;
	listenerInstalled = true;

	bus.onMessage((msg) => {
		if (gmChannel && msg.channel === gmChannel) {
			roundGateSeq = msg.seq;
			return;
		}
		if (seenSeq.has(msg.seq)) return;
		seenSeq.add(msg.seq);
		mailbox.push(msg);
	});
}

export function isMailBoxConnected(): boolean {
	return Boolean(activeBus);
}

export function readMailBox(options?: ReadOptions): MessagePushPayload[] {
	const limit = options?.limit ?? mailbox.length;
	const clear = options?.clear ?? true;
	const gateSeq = roundGateSeq;
	const items: MessagePushPayload[] = [];
	const indices: number[] = [];

	for (let i = 0; i < mailbox.length && items.length < limit; i++) {
		const msg = mailbox[i];
		if (gateSeq !== null && msg.seq > gateSeq) continue;
		items.push(msg);
		indices.push(i);
	}

	if (clear && indices.length > 0) {
		for (let i = indices.length - 1; i >= 0; i--) {
			const idx = indices[i];
			const [removed] = mailbox.splice(idx, 1);
			if (removed) seenSeq.delete(removed.seq);
		}
	}

	return items;
}

export function getMailBoxCount(): number {
	const gateSeq = roundGateSeq;
	if (gateSeq === null) return mailbox.length;
	return mailbox.reduce(
		(count, msg) => (msg.seq <= gateSeq ? count + 1 : count),
		0,
	);
}

