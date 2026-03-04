import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { setBusSendDefaultChannel, setBusSendHandle } from "../tools/bus-send.js";
import registerGameSystemPromptExtension from "./game/system-prompt.js";
import { initSubsystems, shutdownSubsystems, type SubsystemHandles } from "./lifecycle.js";
import { getGameChannel, getGameGmChannel, loadGameIdentity } from "./game/identity.js";
import { createGameBusMessageInjector } from "./game/bus-injection.js";
import { setMailBoxHandle } from "./game/mailbox.js";
import { resolveGameToolExtensions } from "./game/tools.js";
import { registerBusCommands, setBusCommandDefaultChannel, setBusHandle } from "./commands/bus.js";

export default function monoGameExtension(pi: ExtensionAPI) {
	pi.registerFlag("game-channel", {
		description: "Override the game channel name",
		type: "string",
	});

	registerGameSystemPromptExtension(pi);
	registerBusCommands(pi);

	let handles: SubsystemHandles | null = null;

	pi.on("session_start", async (_event, ctx) => {
		if (handles) {
			setBusHandle(null);
			setBusCommandDefaultChannel(undefined);
			setBusSendHandle(null);
			setBusSendDefaultChannel(undefined);
			setMailBoxHandle(null);
			await shutdownSubsystems(handles);
			handles = null;
		}

		const identity = loadGameIdentity(ctx.cwd);
		const channelOverride = pi.getFlag("game-channel");
		const gameChannel = getGameChannel(
			ctx.cwd,
			typeof channelOverride === "string" ? channelOverride : undefined,
		);
		const gmChannel = getGameGmChannel(gameChannel);
		const roleTools = resolveGameToolExtensions(identity.tools);
		for (const register of roleTools) {
			register(pi);
		}
		setBusSendDefaultChannel(gameChannel);
		try {
			const h = await initSubsystems(pi, ctx, {
				displayName: identity.displayName,
				busChannels: [gameChannel, gmChannel],
				busMessageFilter: (msg) => {
					if (!msg.channel) return false;
					return msg.channel === gmChannel;
				},
				busMessageInjector: createGameBusMessageInjector(pi, { gmChannel }),
			});
			handles = h;
			setBusHandle(h.bus);
			setBusCommandDefaultChannel(gameChannel);
			setBusSendHandle(h.bus);
			setMailBoxHandle(h.bus, { gmChannel });
		} catch (err) {
			console.warn(`[subsystems] init failed: ${String(err)}`);
		}
	});

	pi.on("session_shutdown", async () => {
		setBusHandle(null);
		setBusCommandDefaultChannel(undefined);
		setBusSendHandle(null);
		setBusSendDefaultChannel(undefined);
		setMailBoxHandle(null);
		await shutdownSubsystems(handles);
		handles = null;
	});
}
