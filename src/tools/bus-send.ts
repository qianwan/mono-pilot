/**
 * bus_send tool — lets the agent send messages to other agents via the cluster bus.
 */
import { keyHint, type ExtensionAPI, type ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { BusHandle } from "../cluster/bus.js";

let activeBus: BusHandle | null = null;
let defaultBroadcastChannel: string | undefined;

export function setBusSendHandle(bus: BusHandle | null): void {
	activeBus = bus;
}

export function setBusSendDefaultChannel(channel: string | undefined): void {
	defaultBroadcastChannel = channel;
}

import { Type, type Static } from "@sinclair/typebox";

const busSendSchema = Type.Object({
	to: Type.String({
		description: "Target displayName/agentId or channel.",
	}),
	message: Type.String({ description: "The message text to send." }),
});

type BusSendInput = Static<typeof busSendSchema>;

const busSendExtension: ExtensionFactory = (pi: ExtensionAPI) => {
	pi.registerTool({
		name: "BusSend",
		label: "BusSend",
		description:
			"Send a message to a displayName/agentId or broadcast to a channel via the cluster message bus.",
		parameters: busSendSchema,
		renderCall(args, theme) {
			const input = args as Partial<BusSendInput>;
			const target = input.to ? `→ ${input.to}` : `→ (missing)`;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("BusSend"))} ${theme.fg("toolOutput", target)}`,
				0, 0,
			);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("muted", "Sending..."), 0, 0);
			const text = result.content.find(
				(e): e is { type: "text"; text: string } => e.type === "text",
			)?.text ?? "";
			const details = result.details as { message?: string } | undefined;
			const color = text.startsWith("Send failed") ? "error" : "success";
			if (!expanded) {
				const summary =
					`${theme.fg(color, text)} ` +
					`${theme.fg("muted", `(click or ${keyHint("expandTools", "to expand")})`)}`;
				return new Text(summary, 0, 0);
			}
			const messageLine = details?.message
				? `${theme.fg("muted", "message:")} ${theme.fg("toolOutput", details.message)}`
				: "";
			let body = messageLine ? `${messageLine}\n${theme.fg(color, text)}` : theme.fg(color, text);
			body += theme.fg("muted", `\n(click or ${keyHint("expandTools", "to collapse")})`);
			return new Text(body, 0, 0);
		},
		async execute(_toolCallId: string, params: BusSendInput) {
			const { to, message } = params;

			if (!activeBus) {
				return {
					content: [{ type: "text" as const, text: "Bus not connected." }],
					details: { status: "not_connected", to, message },
				};
			}

			try {
				{
					const isChannel = to.includes(":") || to === "public";
					if (isChannel) {
						const { seq, delivered } = await activeBus.broadcast({ text: message }, to);
						return {
							content: [
								{
									type: "text" as const,
									text: `Broadcast to ${to} (seq=${seq}, ${delivered} recipients)`,
								},
							],
							details: { status: "broadcast", to, message },
						};
					}


					const { agentId, displayName } = await activeBus.resolveTarget(to);
					const privateChannel = `private:${agentId}`;
					const { seq, delivered } = await activeBus.broadcast({ text: message }, privateChannel);
					const label = displayName?.trim()
						? `${displayName} (${agentId})`
						: agentId;
					return {
						content: [
							{
								type: "text" as const,
								text: `Sent to ${label} via ${privateChannel} (seq=${seq}, ${delivered} recipients)`,
							},
						],
						details: { status: "sent", to, message },
					};
				}
			} catch (err) {
				const msg = (err as Error).message;
				return {
					content: [{ type: "text" as const, text: `Send failed: ${msg}` }],
					details: { status: "error", to, message, error: msg },
				};
			}
		},
	});
};

export default busSendExtension;
