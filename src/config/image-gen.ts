export interface ImageGenModelConfig {
	id: string;
	name?: string;
}

export interface ImageGenProviderConfig {
	baseUrl?: string;
	apiKey?: string;
	authHeader?: boolean;
	models?: ImageGenModelConfig[];
}

export interface ImageGenSelection {
	provider?: string;
	model?: string;
}

export interface ImageGenConfig {
	providers: Record<string, ImageGenProviderConfig>;
	selection: ImageGenSelection;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function extractImageGenConfig(config: Record<string, unknown> | undefined): ImageGenConfig {
	const providers: Record<string, ImageGenProviderConfig> = {};
	const selection: ImageGenSelection = {};

	if (!config) {
		return { providers, selection };
	}

	if (isRecord(config.imageGen)) {
		selection.provider = readString(config.imageGen.provider);
		selection.model = readString(config.imageGen.model);
	}

	if (isRecord(config.imageGenProviders)) {
		for (const [key, value] of Object.entries(config.imageGenProviders)) {
			if (!isRecord(value)) continue;
			const modelsRaw = Array.isArray(value.models) ? value.models : [];
			const models: ImageGenModelConfig[] = modelsRaw
				.map((entry) => {
					if (!isRecord(entry)) return undefined;
					const id = readString(entry.id);
					if (!id) return undefined;
					const name = readString(entry.name);
					return name ? { id, name } : { id };
				})
				.filter((entry): entry is ImageGenModelConfig => Boolean(entry));
			providers[key] = {
				baseUrl: readString(value.baseUrl),
				apiKey: readString(value.apiKey),
				authHeader: typeof value.authHeader === "boolean" ? value.authHeader : undefined,
				models: models.length > 0 ? models : undefined,
			};
		}
	}

	return { providers, selection };
}

export function applyImageGenSelection(
	config: Record<string, unknown>,
	selection: ImageGenSelection,
): void {
	config.imageGen = {
		provider: selection.provider,
		model: selection.model,
	};
}