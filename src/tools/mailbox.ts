/**
 * MailBox tool — lets a game agent read queued bus messages.
 */
import { keyHint, type ExtensionAPI, type ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type, type Static } from "@sinclair/typebox";
import { isMailBoxConnected, readMailBox, getMailBoxCount } from "../extensions/game/mailbox.js";
import type { MessagePushPayload } from "../cluster/protocol.js";

const mailboxSchema = Type.Object({
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "Max messages to return." })),
	clear: Type.Optional(Type.Boolean({ description: "Clear returned messages (default: true)." })),
});

type MailBoxInput = Static<typeof mailboxSchema>;

const mailboxExtension: ExtensionFactory = (pi: ExtensionAPI) => {
	pi.registerTool({
		name: "MailBox",
		label: "MailBox",
		description:
			"Read queued message-bus items that were not injected into the conversation. " +
			"Use this to check public or private messages in game mode.",
		parameters: mailboxSchema,
		renderCall(args, theme) {
			const input = args as Partial<MailBoxInput>;
			const limit = input.limit ? `limit=${input.limit}` : "all";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("mailbox"))} ${theme.fg("toolOutput", limit)}`,
				0, 0,
			);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("muted", "Loading..."), 0, 0);
			const text = result.content.find(
				(e): e is { type: "text"; text: string } => e.type === "text",
			)?.text ?? "";

			const details = result.details as { count?: number; remaining?: number } | undefined;
			const count = details?.count;
			const remaining = details?.remaining ?? 0;

			if (!expanded && typeof count === "number") {
				const extra = remaining > 0 ? `, ${remaining} unread` : "";
				const summary = `${count} messages${extra} (click or ${keyHint("expandTools", "to expand")})`;
				return new Text(theme.fg("muted", summary), 0, 0);
			}

			let body = text
				.split("\n")
				.map((line) => theme.fg("toolOutput", line))
				.join("\n");
			if (typeof count === "number") {
				body += theme.fg("muted", `\n(click or ${keyHint("expandTools", "to collapse")})`);
			}
			return new Text(body, 0, 0);
		},
		async execute(_toolCallId: string, params: MailBoxInput) {
			if (!isMailBoxConnected()) {
				return {
					content: [{ type: "text" as const, text: "MailBox not connected." }],
					details: "not_connected",
				};
			}

			const items = readMailBox({ limit: params.limit, clear: params.clear });
			if (items.length === 0) {
				return {
					content: [{ type: "text" as const, text: "MailBox empty." }],
					details: "empty",
				};
			}

			const lines = items.map((msg) => formatMessage(msg));
			const remaining = getMailBoxCount();
			const header = `MailBox (${items.length}):`;
			const footer = remaining > 0 ? `\n(${remaining} more unread)` : "";
			return {
				content: [{ type: "text" as const, text: `${header}\n${lines.join("\n")}${footer}` }],
				details: { count: items.length, remaining },
			};
		},
	});
};

function formatMessage(msg: MessagePushPayload): string {
	const text =
		typeof msg.payload === "object" && msg.payload !== null && "text" in msg.payload
			? (msg.payload as { text: string }).text
			: JSON.stringify(msg.payload);
	const sender = msg.fromName ?? msg.from;
	const channel = msg.channel ?? "public";
	const channelLabel = channel.startsWith("private:") ? "私信" : channel;
	return [
		`- from: ${sender}`,
		`  seq: ${msg.seq}`,
		`  channel: ${channelLabel}`,
		`  message: ${text}`,
		"",
	].join("\n");
}

export default mailboxExtension;