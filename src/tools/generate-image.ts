import { readFileSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import { Text } from "@mariozechner/pi-tui";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { loadMonoPilotConfigObject } from "../config/mono-pilot.js";
import { extractImageGenConfig } from "../config/image-gen.js";

const DESCRIPTION = `Generate images using the Google Gemini API or OpenRouter (default model \`gemini-3.1-flash-image-preview\`).

Use when you need to create or edit an image from a text prompt. Optionally provide an input image for edits.

Requirements:
- Provider \`gemini\`: set an API key in \`~/.mono-pilot/config.json\`.
- Provider \`openrouter\`: set an API key in \`~/.mono-pilot/config.json\`.
- Default provider/model can be set in \`~/.mono-pilot/config.json\` under \`imageGen\`.

Inputs:
- \`prompt\` is required.
- \`image_path\` or \`image_base64\` (with \`image_mime_type\`) are optional for image editing.
- \`output_path\` is optional to save the first generated image.

Outputs:
- Returns text parts (if any) and one or more image parts.
- Image parts use \`ImageContent\` format: { "type": "image", "data": "<base64>", "mimeType": "image/png" }.`;

const DEFAULT_MODEL = "gemini-3.1-flash-image-preview";
const DEFAULT_OPENROUTER_MODEL = "google/gemini-3.1-flash-image-preview";
const REQUEST_TIMEOUT_MS = 60_000;

const generateImageSchema = Type.Object({
	prompt: Type.String({
		description: "Text prompt used to generate or edit the image.",
	}),
	image_path: Type.Optional(
		Type.String({
			description: "Optional path to an input image for editing.",
		}),
	),
	image_base64: Type.Optional(
		Type.String({
			description: "Optional base64-encoded input image data.",
		}),
	),
	image_mime_type: Type.Optional(
		Type.String({
			description: "MIME type for image_base64 (e.g., image/png).",
		}),
	),
	output_path: Type.Optional(
		Type.String({
			description: "Optional output path to save the first generated image.",
		}),
	),
});

type GenerateImageInput = Static<typeof generateImageSchema>;

interface GenerateImageDetails {
	provider: "gemini" | "openrouter";
	model: string;
	prompt?: string;
	input_image_ref?: string;
	input_image_source?: "path" | "base64";
	input_image_mime_type?: string;
	output_image_path?: string;
	output_image_written?: boolean;
	image_count?: number;
	text_count?: number;
	used_input_image?: boolean;
	api_key?: string;
	api_key_source?: "config" | "missing";
	response?: string;
	error?: string;
}

type ImageGenProvider = "gemini" | "openrouter";

function normalizeProvider(value: string | undefined): ImageGenProvider {
	return value === "openrouter" ? "openrouter" : "gemini";
}

function normalizePrompt(prompt: string): string {
	return prompt.trim();
}

function detectMimeType(path: string): string | undefined {
	const ext = extname(path).toLowerCase();
	if (ext === ".png") return "image/png";
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".gif") return "image/gif";
	if (ext === ".webp") return "image/webp";
	return undefined;
}

function collectInputImageInfo(params: GenerateImageInput): {
	ref?: string;
	source?: "path" | "base64";
	mimeType?: string;
} {
	if (params.image_path) {
		return { ref: params.image_path, source: "path" };
	}
	if (params.image_base64) {
		const mimeType = params.image_mime_type;
		const ref = mimeType
			? `data:${mimeType};base64,${params.image_base64}`
			: params.image_base64;
		return { ref, source: "base64", mimeType };
	}
	return {};
}

function buildParts(params: GenerateImageInput): { parts: Array<Record<string, unknown>>; usedInput: boolean } {
	const parts: Array<Record<string, unknown>> = [];

	if (params.image_path) {
		const buffer = readFileSync(params.image_path);
		const mimeType = detectMimeType(params.image_path);
		if (!mimeType) {
			throw new Error("Unsupported image_path extension. Use png/jpg/gif/webp.");
		}
		parts.push({
			inlineData: {
				mimeType,
				data: buffer.toString("base64"),
			},
		});
	}

	if (params.image_base64) {
		if (!params.image_mime_type) {
			throw new Error("image_mime_type is required when image_base64 is provided.");
		}
		parts.push({
			inlineData: {
				mimeType: params.image_mime_type,
				data: params.image_base64,
			},
		});
	}

	parts.push({ text: normalizePrompt(params.prompt) });

	return { parts, usedInput: Boolean(params.image_path || params.image_base64) };
}

function collectResponseParts(parts: Array<Record<string, unknown>>): {
	content: Array<TextContent | ImageContent>;
	imageCount: number;
	textCount: number;
} {
	const content: Array<TextContent | ImageContent> = [];
	let imageCount = 0;
	let textCount = 0;

	for (const part of parts) {
		const text = typeof part.text === "string" ? part.text : undefined;
		const inlineData =
			(typeof part.inlineData === "object" && part.inlineData !== null && part.inlineData) ||
			(typeof part.inline_data === "object" && part.inline_data !== null && part.inline_data);
		if (text) {
			content.push({ type: "text", text });
			textCount += 1;
			continue;
		}

		if (inlineData && typeof inlineData === "object") {
			const data = (inlineData as { data?: unknown }).data;
			const mimeType =
				(inlineData as { mimeType?: unknown }).mimeType ?? (inlineData as { mime_type?: unknown }).mime_type;
			if (typeof data === "string" && typeof mimeType === "string") {
				content.push({ type: "image", data, mimeType });
				imageCount += 1;
			}
		}
	}

	return { content, imageCount, textCount };
}

function parseDataUrl(url: string): { mimeType: string; data: string } | null {
	if (!url.startsWith("data:")) {
		return null;
	}
	const match = url.match(/^data:([^;]+);base64,(.*)$/);
	if (!match) {
		return null;
	}
	return { mimeType: match[1], data: match[2] };
}

function collectOpenRouterParts(message: Record<string, unknown>): {
	content: Array<TextContent | ImageContent>;
	imageCount: number;
	textCount: number;
} {
	const content: Array<TextContent | ImageContent> = [];
	let imageCount = 0;
	let textCount = 0;

	const messageContent = message.content;
	const text = typeof messageContent === "string" ? messageContent : undefined;
	if (text) {
		content.push({ type: "text", text });
		textCount += 1;
	}

	if (Array.isArray(messageContent)) {
		for (const part of messageContent) {
			if (!part || typeof part !== "object") {
				continue;
			}
			const partType = (part as { type?: unknown }).type;
			if (partType === "text" && typeof (part as { text?: unknown }).text === "string") {
				content.push({ type: "text", text: (part as { text: string }).text });
				textCount += 1;
				continue;
			}
			if (partType === "image_url") {
				const imageUrl =
					(typeof (part as { image_url?: unknown }).image_url === "object" &&
						(part as { image_url?: unknown }).image_url !== null
						? ((part as { image_url: { url?: unknown } }).image_url.url as unknown)
						: undefined) ??
					(typeof (part as { url?: unknown }).url === "string" ? (part as { url: string }).url : undefined);
				if (typeof imageUrl !== "string") {
					continue;
				}
				const parsed = parseDataUrl(imageUrl);
				if (parsed) {
					content.push({ type: "image", data: parsed.data, mimeType: parsed.mimeType });
					imageCount += 1;
					continue;
				}
				content.push({ type: "text", text: `OpenRouter image URL: ${imageUrl}` });
				textCount += 1;
			}
		}
	}

	const images = Array.isArray(message.images) ? (message.images as Array<Record<string, unknown>>) : [];
	for (const image of images) {
		const imageUrl =
			(typeof image.image_url === "object" && image.image_url !== null
				? (image.image_url as { url?: unknown }).url
				: undefined) ??
			(typeof image.url === "string" ? image.url : undefined);
		if (typeof imageUrl !== "string") {
			continue;
		}
		const parsed = parseDataUrl(imageUrl);
		if (parsed) {
			content.push({ type: "image", data: parsed.data, mimeType: parsed.mimeType });
			imageCount += 1;
			continue;
		}
		content.push({ type: "text", text: `OpenRouter image URL: ${imageUrl}` });
		textCount += 1;
	}

	return { content, imageCount, textCount };
}

function findFirstImage(content: Array<TextContent | ImageContent>): ImageContent | undefined {
	return content.find((entry): entry is ImageContent => entry.type === "image");
}

function buildOpenRouterMessages(
	prompt: string,
	parts: Array<Record<string, unknown>>,
	usedInput: boolean,
): Array<Record<string, unknown>> {
	if (!usedInput) {
		return [{ role: "user", content: prompt }];
	}
	const content = parts.map((part) => {
		if ("inlineData" in part && typeof part.inlineData === "object" && part.inlineData) {
			const inlineData = part.inlineData as { mimeType?: unknown; data?: unknown };
			if (typeof inlineData.mimeType === "string" && typeof inlineData.data === "string") {
				return {
					type: "image_url",
					image_url: {
						url: `data:${inlineData.mimeType};base64,${inlineData.data}`,
					},
				};
			}
		}
		if ("text" in part && typeof part.text === "string") {
			return { type: "text", text: part.text };
		}
		return { type: "text", text: JSON.stringify(part) };
	});
	return [{ role: "user", content }];
}

function resolveOpenRouterEndpoint(baseUrl?: string): string {
	const fallback = "https://openrouter.ai/api/v1/chat/completions";
	if (!baseUrl) return fallback;
	const trimmed = baseUrl.trim();
	if (!trimmed) return fallback;
	const normalized = trimmed.replace(/\/+$/, "");
	if (normalized.endsWith("/chat/completions")) {
		return normalized;
	}
	return `${normalized}/chat/completions`;
}

function chunkText(text: string, size: number): string[] {
	if (text.length <= size) return [text];
	const chunks: string[] = [];
	for (let i = 0; i < text.length; i += size) {
		chunks.push(text.slice(i, i + size));
	}
	return chunks;
}

function buildResponseTextParts(payload: unknown, chunkSize = 1800): TextContent[] {
	const json = JSON.stringify(payload, null, 2);
	return chunkText(json, chunkSize).map((text) => ({ type: "text", text }));
}

export default function generateImageExtension(pi: ExtensionAPI) {
	// System prompt injection is handled centrally by system-prompt extension.

	pi.registerTool({
		name: "GenerateImage",
		label: "GenerateImage",
		description: DESCRIPTION,
		parameters: generateImageSchema,
		renderCall(args, theme) {
			const input = args as Partial<GenerateImageInput>;
			const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
			const displayPrompt = prompt.length > 80 ? `${prompt.slice(0, 79)}…` : prompt || "(missing prompt)";
			let text = theme.fg("toolTitle", theme.bold("GenerateImage"));
			text += ` ${theme.fg("toolOutput", displayPrompt)}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("muted", "Generating image..."), 0, 0);
			}
			const details = (result.details ?? {}) as Partial<GenerateImageDetails>;
			const textBlocks = result.content.filter(
				(entry): entry is TextContent => entry.type === "text" && typeof entry.text === "string",
			);
			if (!expanded) {
				if (details.output_image_written && details.output_image_path) {
					const summary = `saved: ${details.output_image_path}`;
					return new Text(
						theme.fg("muted", `${summary} (click or ${keyHint("expandTools", "to expand")})`),
						0,
						0,
					);
				}
				const imageCount = result.content.filter((entry) => entry.type === "image").length;
				const summary = `${imageCount} image${imageCount === 1 ? "" : "s"}`;
				return new Text(theme.fg("muted", `${summary} (click or ${keyHint("expandTools", "to expand")})`), 0, 0);
			}
			const lines: string[] = [];
			for (const block of textBlocks) {
				lines.push(...block.text.split("\n"));
			}
			if (details.prompt) {
				lines.push(theme.fg("muted", `prompt: ${details.prompt}`));
			}
			if (details.input_image_ref) {
				lines.push(theme.fg("muted", `input image: ${details.input_image_ref}`));
			}
			if (details.output_image_path) {
				const suffix = details.output_image_written === false ? " (failed)" : "";
				lines.push(theme.fg("muted", `output image: ${details.output_image_path}${suffix}`));
			}
			if (details.provider) {
				lines.push(theme.fg("muted", `provider: ${details.provider}`));
			}
			lines.push(theme.fg("muted", `(click or ${keyHint("expandTools", "to collapse")})`));
			return new Text(lines.join("\n"), 0, 0);
		},
		async execute(_toolCallId, params: GenerateImageInput, signal) {
			const normalizedPrompt = normalizePrompt(params.prompt ?? "");
			const inputImageInfo = collectInputImageInfo(params);
			const baseDetails = {
				prompt: normalizedPrompt || undefined,
				input_image_ref: inputImageInfo.ref,
				input_image_source: inputImageInfo.source,
				input_image_mime_type: inputImageInfo.mimeType,
				output_image_path: params.output_path,
			};
			let config: Record<string, unknown> = {};
			try {
				config = await loadMonoPilotConfigObject();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const fallbackProvider = "gemini";
				return {
					content: [{ type: "text", text: `GenerateImage error: ${message}` }],
					details: {
						provider: fallbackProvider,
						model: DEFAULT_MODEL,
						...baseDetails,
						error: message,
						api_key_source: "missing",
					} satisfies GenerateImageDetails,
				};
			}
			const imageGenConfig = extractImageGenConfig(config);
			const provider = normalizeProvider(imageGenConfig.selection.provider);
			const providerConfig = imageGenConfig.providers[provider];
			const apiKeyFromConfig = providerConfig?.apiKey?.trim();
			const apiKey = apiKeyFromConfig;
			const apiKeySource: GenerateImageDetails["api_key_source"] = apiKeyFromConfig ? "config" : "missing";
			const model =
				imageGenConfig.selection.model?.trim() ||
				providerConfig?.models?.[0]?.id ||
				(provider === "openrouter" ? DEFAULT_OPENROUTER_MODEL : DEFAULT_MODEL);
			const apiKeyInfo = {
				provider,
				api_key: apiKey ?? "",
				api_key_source: apiKeySource,
			};
			if (!apiKey) {
				return {
					content: [
						{
							type: "text",
							text: "GenerateImage error: missing API key. Provide api_key or set it in ~/.mono-pilot/config.json.",
						},
					],
					details: {
						model,
						...baseDetails,
						error: "missing api key",
						...apiKeyInfo,
					} satisfies GenerateImageDetails,
				};
			}

			if (params.image_path && params.image_base64) {
				return {
					content: [
						{
							type: "text",
							text: "GenerateImage error: provide only one of image_path or image_base64.",
						},
					],
					details: {
						model,
						...baseDetails,
						error: "invalid input",
						...apiKeyInfo,
					} satisfies GenerateImageDetails,
				};
			}

			const prompt = normalizedPrompt;
			if (prompt.length === 0) {
				return {
					content: [{ type: "text", text: "GenerateImage error: prompt cannot be empty." }],
					details: {
						model,
						...baseDetails,
						error: "empty prompt",
						...apiKeyInfo,
					} satisfies GenerateImageDetails,
				};
			}

			let parts: Array<Record<string, unknown>> = [];
			let usedInput = false;
			try {
				const built = buildParts(params);
				parts = built.parts;
				usedInput = built.usedInput;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `GenerateImage error: ${message}` }],
					details: {
						model,
						...baseDetails,
						error: message,
						...apiKeyInfo,
					} satisfies GenerateImageDetails,
				};
			}
			const openRouterMessages = buildOpenRouterMessages(prompt, parts, usedInput);
			const openRouterBaseUrl =
				provider === "openrouter" ? resolveOpenRouterEndpoint(providerConfig?.baseUrl) : "";
			const useAuthHeader = providerConfig?.authHeader !== false;
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
			const onAbort = () => controller.abort();
			signal?.addEventListener("abort", onAbort, { once: true });

			try {
				const response =
					provider === "openrouter"
						? await fetch(openRouterBaseUrl, {
								method: "POST",
								headers: {
									...(useAuthHeader ? { Authorization: `Bearer ${apiKey}` } : { "x-api-key": apiKey }),
									"Content-Type": "application/json",
								},
								body: JSON.stringify({
									model,
									messages: openRouterMessages,
									modalities: ["image", "text"],
								}),
								signal: controller.signal,
						})
						: await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
								method: "POST",
								headers: {
									"x-goog-api-key": apiKey,
									"Content-Type": "application/json",
								},
								body: JSON.stringify({
									contents: [{ parts }],
									generationConfig: {
										responseModalities: ["TEXT", "IMAGE"],
									},
								}),
								signal: controller.signal,
						});

				const payload = (await response.json()) as Record<string, unknown>;
				if (!response.ok) {
					const errorMessage =
						(typeof payload.error === "object" && payload.error !== null && "message" in payload.error
								? String((payload.error as { message?: unknown }).message ?? "")
								: "") || JSON.stringify(payload);
					const responseParts = buildResponseTextParts(payload);
					return {
						content: [
								{
									type: "text",
									text: `GenerateImage error: HTTP ${response.status} ${response.statusText}\n${errorMessage}`,
								},
								...responseParts,
						],
						details: {
								model,
								...baseDetails,
								response: JSON.stringify(payload),
								error: JSON.stringify(payload),
								...apiKeyInfo,
						} satisfies GenerateImageDetails,
					};
				}

				const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
				const firstCandidate = candidates[0] as Record<string, unknown> | undefined;
				const openRouterChoices = Array.isArray(payload.choices) ? payload.choices : [];
				const openRouterMessageRaw =
					(openRouterChoices[0] as Record<string, unknown> | undefined)?.message ?? {};
				const openRouterMessage =
					typeof openRouterMessageRaw === "object" && openRouterMessageRaw !== null
						? (openRouterMessageRaw as Record<string, unknown>)
						: {};
				const collected =
					provider === "openrouter"
						? collectOpenRouterParts(openRouterMessage)
						: collectResponseParts(
									Array.isArray((firstCandidate?.content as Record<string, unknown> | undefined)?.parts)
										? (((firstCandidate?.content as Record<string, unknown> | undefined) ?? {}).parts as Array<
											Record<string, unknown>
											>)
										: [],
							  );

				if (collected.content.length === 0) {
					const responseParts = buildResponseTextParts(payload);
					return {
						content: [
								{ type: "text", text: "GenerateImage: no image data returned." },
								...responseParts,
						],
						details: {
								model,
								...baseDetails,
								image_count: 0,
								text_count: 0,
								used_input_image: usedInput || undefined,
								response: JSON.stringify(payload),
								...apiKeyInfo,
						} satisfies GenerateImageDetails,
					};
				}

				let outputWritten: boolean | undefined;
				if (params.output_path) {
					const image = findFirstImage(collected.content);
					if (image) {
						try {
								writeFileSync(params.output_path, Buffer.from(image.data, "base64"));
								outputWritten = true;
						} catch (error) {
								const message = error instanceof Error ? error.message : String(error);
								return {
								content: [{ type: "text", text: `GenerateImage error: ${message}` }, ...collected.content],
								details: {
									model,
									...baseDetails,
									output_image_written: false,
									image_count: collected.imageCount,
									text_count: collected.textCount,
									used_input_image: usedInput || undefined,
									response: JSON.stringify(payload),
									error: message,
									...apiKeyInfo,
								} satisfies GenerateImageDetails,
								};
						}
					} else {
						outputWritten = false;
					}
				}

				const outputContent: Array<TextContent | ImageContent> =
					outputWritten && params.output_path
						? [
								({ type: "text", text: `GenerateImage saved: ${params.output_path}` } satisfies TextContent),
								...collected.content.filter((entry): entry is TextContent => entry.type === "text"),
						  ]
						: collected.content;
				return {
					content: outputContent,
					details: {
						model,
						...baseDetails,
						output_image_written: outputWritten,
						image_count: collected.imageCount,
						text_count: collected.textCount,
						used_input_image: usedInput || undefined,
						response: JSON.stringify(payload),
						...apiKeyInfo,
					} satisfies GenerateImageDetails,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const timeoutMessage = controller.signal.aborted
					? `GenerateImage error: request timed out after ${REQUEST_TIMEOUT_MS}ms.`
					: `GenerateImage error: ${message}`;
				return {
					content: [{ type: "text", text: timeoutMessage }],
					details: {
						model,
						...baseDetails,
						error: message,
						...apiKeyInfo,
					} satisfies GenerateImageDetails,
				};
			} finally {
				clearTimeout(timeoutId);
				signal?.removeEventListener("abort", onAbort);
			}
		},
	});
}