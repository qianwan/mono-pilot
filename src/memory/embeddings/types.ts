export interface EmbeddingProvider {
	id: "local";
	model: string;
	maxInputTokens?: number;
	embedQuery: (text: string) => Promise<number[]>;
	embedBatch: (texts: string[]) => Promise<number[][]>;
	dispose?: () => Promise<void> | void;
}