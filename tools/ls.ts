import { keyHint, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createLsTool, type LsToolInput } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

// Grab schema, description, label from the builtin ls tool
const builtinLs = createLsTool(process.cwd());

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: builtinLs.name,
		label: builtinLs.label,
		description: builtinLs.description,
		parameters: builtinLs.parameters,
		renderCall(args, theme) {
			const input = args as Partial<LsToolInput>;
			const dir = typeof input.path === "string" && input.path.trim().length > 0
				? input.path
				: ".";
			let text = theme.fg("toolTitle", theme.bold("ls"));
			text += ` ${theme.fg("toolOutput", dir)}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("muted", "Listing..."), 0, 0);
			}
			const textBlock = result.content.find(
				(entry): entry is { type: "text"; text: string } => entry.type === "text",
			);
			if (!textBlock) {
				return new Text(theme.fg("error", "No output."), 0, 0);
			}

			const fullText = textBlock.text;
			const entryCount = fullText.split("\n").filter(Boolean).length;

			if (!expanded) {
				const summary = `${entryCount} entries (click or ${keyHint("expandTools", "to expand")})`;
				return new Text(theme.fg("muted", summary), 0, 0);
			}

			let text = fullText
				.split("\n")
				.map((line: string) => theme.fg("toolOutput", line))
				.join("\n");
			text += theme.fg("muted", `\n(click or ${keyHint("expandTools", "to collapse")})`);
			return new Text(text, 0, 0);
		},
		async execute(toolCallId, params: LsToolInput, signal, onUpdate, ctx: { cwd: string }) {
			// Delegate to the built-in ls tool, constructed with the runtime cwd
			const delegate = createLsTool(ctx.cwd);
			return delegate.execute(toolCallId, params, signal, onUpdate);
		},
	});
}