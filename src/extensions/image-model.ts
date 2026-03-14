import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { loadMonoPilotConfigObject, saveMonoPilotConfigObject } from "../config/mono-pilot.js";
import { applyImageGenSelection, extractImageGenConfig, type ImageGenProviderConfig } from "../config/image-gen.js";

type NotifyLevel = "info" | "warning" | "error";

const USAGE = [
	"Usage:",
	"  /image-model            (open interactive picker)",
	"  /image-model list",
	"  /image-model use <provider> [modelId]",
	"  /image-model <provider> [modelId]",
].join("\n");

interface ImageModelCommand {
	cmd: "list" | "use" | "current";
	provider?: string;
	model?: string;
}

interface ImageModelEntry {
	provider: string;
	model?: string;
	label: string;
}

export function registerImageModelCommands(pi: ExtensionAPI): void {
	pi.registerCommand("image-model", {
		description: "Switch image generation model/provider from config.json",
		handler: async (args, ctx) => {
			let config: Record<string, unknown>;
			try {
				config = await loadMonoPilotConfigObject();
			} catch (error) {
				notify(ctx, (error as Error).message, "error");
				return;
			}

			const { providers, selection } = extractImageGenConfig(config);
			const providerNames = Object.keys(providers);
			if (providerNames.length === 0) {
				notify(
					ctx,
					"No imageGenProviders configured in ~/.mono-pilot/config.json.",
					"warning",
				);
				return;
			}

			const trimmedArgs = args.trim();
			if (!trimmedArgs) {
				if (!ctx.hasUI) {
					notify(ctx, `Interactive picker unavailable.\n${USAGE}`, "warning");
					return;
				}
				const entries = buildEntries(providers);
				if (entries.length === 0) {
					notify(ctx, "No image models configured.", "warning");
					return;
				}
				const selected = await pickImageModel(ctx, entries, selection.provider, selection.model);
				if (!selected) {
					notify(ctx, "Image model selection cancelled.", "info");
					return;
				}
				applyImageGenSelection(config, {
					provider: selected.provider,
					model: selected.model,
				});
				try {
					await saveMonoPilotConfigObject(config);
				} catch (error) {
					notify(ctx, (error as Error).message, "error");
					return;
				}
				const modelSuffix = selected.model ? ` (${selected.model})` : "";
				notify(ctx, `Image model set to ${selected.provider}${modelSuffix}.`, "info");
				return;
			}

			const command = parseCommand(args);
			switch (command.cmd) {
				case "list": {
					notify(ctx, formatProviders(providers, selection.provider, selection.model), "info");
					return;
				}
				case "use": {
					if (!command.provider) {
						notify(ctx, `Missing provider.\n${USAGE}`, "warning");
						return;
					}
					const providerConfig = providers[command.provider];
					if (!providerConfig) {
						notify(
							ctx,
							`Unknown provider: ${command.provider}.\n${formatProviders(providers)}`,
							"warning",
						);
						return;
					}
					const nextModel = resolveModelSelection(
						providerConfig,
						command.model,
						command.provider === selection.provider ? selection.model : undefined,
					);
					if (command.model && providerConfig.models?.length && nextModel !== command.model) {
						notify(
							ctx,
							`Unknown model for ${command.provider}: ${command.model}.\n${formatModels(providerConfig)}`,
							"warning",
						);
						return;
					}

					applyImageGenSelection(config, {
						provider: command.provider,
						model: nextModel,
					});
					try {
						await saveMonoPilotConfigObject(config);
					} catch (error) {
						notify(ctx, (error as Error).message, "error");
						return;
					}
					const modelSuffix = nextModel ? ` (${nextModel})` : "";
					notify(ctx, `Image model set to ${command.provider}${modelSuffix}.`, "info");
					return;
				}
				case "current":
				default: {
					notify(ctx, formatProviders(providers, selection.provider, selection.model, true), "info");
					return;
				}
			}
		},
	});
}

function parseCommand(raw: string): ImageModelCommand {
	const trimmed = raw.trim();
	if (!trimmed) return { cmd: "current" };
	const parts = trimmed.split(/\s+/);
	const [first, second, third] = parts;
	if (first === "list") {
		return { cmd: "list" };
	}
	if (first === "use") {
		return { cmd: "use", provider: second, model: third };
	}
	return { cmd: "use", provider: first, model: second };
}

function resolveModelSelection(
	provider: ImageGenProviderConfig,
	modelOverride?: string,
	currentModel?: string,
): string | undefined {
	if (modelOverride) return modelOverride;
	if (currentModel) return currentModel;
	return provider.models?.[0]?.id;
}

function buildEntries(providers: Record<string, ImageGenProviderConfig>): ImageModelEntry[] {
	const entries: ImageModelEntry[] = [];
	for (const [provider, config] of Object.entries(providers)) {
		const models = config.models ?? [];
		if (models.length === 0) {
			entries.push({ provider, label: provider });
			continue;
		}
		for (const model of models) {
			const label = model.name ? `${provider} · ${model.name}` : `${provider} · ${model.id}`;
			entries.push({ provider, model: model.id, label });
		}
	}
	return entries;
}

async function pickImageModel(
	ctx: ExtensionContext,
	entries: ImageModelEntry[],
	currentProvider?: string,
	currentModel?: string,
): Promise<ImageModelEntry | undefined> {
	const items: SelectItem[] = entries.map((entry, index) => {
		const isCurrent = entry.provider === currentProvider && entry.model === currentModel;
		return {
			value: String(index),
			label: isCurrent ? `${entry.label} (current)` : entry.label,
			description: entry.model ? entry.model : "(provider default)",
		};
	});

	const currentIndex = entries.findIndex(
		(entry) => entry.provider === currentProvider && entry.model === currentModel,
	);

	const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Select Image Model")), 1, 0));

		const selectList = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		if (currentIndex >= 0) {
			selectList.setSelectedIndex(currentIndex);
		}
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});

	if (!result) return undefined;
	const index = Number(result);
	return Number.isFinite(index) ? entries[index] : undefined;
}

function formatModels(provider: ImageGenProviderConfig): string {
	const models = provider.models ?? [];
	if (models.length === 0) {
		return "No models configured for this provider.";
	}
	const lines = models.map((model) => {
		const label = model.name ? `${model.id} (${model.name})` : model.id;
		return `  - ${label}`;
	});
	return `Available models:\n${lines.join("\n")}`;
}

function formatProviders(
	providers: Record<string, ImageGenProviderConfig>,
	currentProvider?: string,
	currentModel?: string,
	includeUsage = false,
): string {
	const lines = Object.entries(providers).map(([name, provider]) => {
		const label = currentProvider === name ? "*" : "-";
		const modelLabel = currentProvider === name && currentModel ? ` (${currentModel})` : "";
		const models = provider.models?.map((model) => model.id).join(", ") ?? "(no models)";
		return `${label} ${name}${modelLabel}: ${models}`;
	});
	const header = includeUsage ? `${USAGE}\n\nConfigured providers:` : "Configured providers:";
	return `${header}\n${lines.join("\n")}`;
}

function notify(
	ctx: { hasUI?: boolean; ui?: { notify?: (msg: string, level?: NotifyLevel) => void } },
	message: string,
	level: NotifyLevel,
): void {
	if (ctx.hasUI && ctx.ui?.notify) {
		ctx.ui.notify(message, level);
	} else {
		const prefix = level === "error" ? "[error]" : level === "warning" ? "[warn]" : "[info]";
		console.log(`${prefix} ${message}`);
	}
}
