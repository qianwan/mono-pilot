import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { MessagePushPayload } from "../../cluster/protocol.js";

export function createGameBusMessageInjector(
	pi: ExtensionAPI,
	options: { gmChannel: string },
): (msg: MessagePushPayload) => void {
	let pending: MessagePushPayload[] = [];
	let timer: ReturnType<typeof setTimeout> | null = null;
	const seenSeq = new Set<number>();
	const seenQueue: number[] = [];

	function markSeen(seq: number): boolean {
		if (seenSeq.has(seq)) return false;
		seenSeq.add(seq);
		seenQueue.push(seq);
		if (seenQueue.length > 200) {
			const dropped = seenQueue.splice(0, seenQueue.length - 200);
			for (const id of dropped) seenSeq.delete(id);
		}
		return true;
	}

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
			const sender = m.fromName?.trim() ? m.fromName.trim() : "GM";
			const ch = m.channel && m.channel !== "public" ? ` [${m.channel}]` : "";
			return `[from ${sender}${ch}] ${text}`;
		});

		const envelope =
			"<bus_messages>\n" + lines.join("\n") + "\n</bus_messages>\n\n" +
			"You received the above in-world messages from GM. " +
			"Stay in character and reply using BusSend when needed.";

		pi.sendUserMessage(envelope, { deliverAs: "followUp" });
	}

	return (msg) => {
		if (msg.channel && msg.channel !== options.gmChannel) return;
		if (!markSeen(msg.seq)) return;
		pending.push(msg);
		if (timer) clearTimeout(timer);
		timer = setTimeout(flush, 300);
	};
}
