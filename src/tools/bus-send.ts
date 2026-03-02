/**
 * bus_send tool — lets the agent send messages to other agents via the cluster bus.
 */
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { BusHandle } from "../cluster/bus.js";

let activeBus: BusHandle | null = null;

export function setBusSendHandle(bus: BusHandle | null): void {
	activeBus = bus;
}

import { Type, type Static } from "@sinclair/typebox";

const busSendSchema = Type.Object({
	to: Type.Optional(
		Type.String({ description: "Target agent ID for direct message. Omit to broadcast." }),
	),
	message: Type.String({ description: "The message text to send." }),
	channel: Type.Optional(
		Type.String({ description: 'Channel to broadcast on (default: "public"). Ignored when "to" is set.' }),
	),
});

type BusSendInput = Static<typeof busSendSchema>;

const busSendExtension: ExtensionFactory = (pi: ExtensionAPI) => {
	pi.registerTool({
		name: "BusSend",
		label: "BusSend",
		description:
			"Send a message to another agent or broadcast to a channel via the cluster message bus. " +
			"Use this to communicate with other agents in multi-agent scenarios.",
		parameters: busSendSchema,
		renderCall(args, theme) {
			const input = args as Partial<BusSendInput>;
			const target = input.to ? `→ ${input.to}` : `broadcast`;
			const msg = input.message ?? "";
			const preview = msg.length > 80 ? msg.slice(0, 77) + "..." : msg;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("bus_send"))} ${theme.fg("toolOutput", target)} ${preview}`,
				0, 0,
			);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("muted", "Sending..."), 0, 0);
			const text = result.content.find(
				(e): e is { type: "text"; text: string } => e.type === "text",
			)?.text ?? "";
			const color = text.startsWith("Send failed") ? "error" : "success";
			return new Text(theme.fg(color, text), 0, 0);
		},
		async execute(_toolCallId: string, params: BusSendInput) {
			const { to, message, channel } = params;

			if (!activeBus) {
				return {
					content: [{ type: "text" as const, text: "Bus not connected." }],
					details: "not_connected",
				};
			}

			try {
				if (to) {
					const { seq } = await activeBus.send(to, { text: message });
					return {
						content: [{ type: "text" as const, text: `Sent to ${to} (seq=${seq})` }],
						details: `sent`,
					};
				} else {
					const { seq, delivered } = await activeBus.broadcast({ text: message }, channel);
					const ch = channel ?? "public";
					return {
						content: [{ type: "text" as const, text: `Broadcast to ${ch} (seq=${seq}, ${delivered} recipients)` }],
						details: `broadcast`,
					};
				}
			} catch (err) {
				const msg = (err as Error).message;
				return {
					content: [{ type: "text" as const, text: `Send failed: ${msg}` }],
					details: `error`,
				};
			}
		},
	});
};

export default busSendExtension;
