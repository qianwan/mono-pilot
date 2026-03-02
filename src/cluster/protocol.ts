/** Wire protocol for cluster IPC over Unix domain socket. */

export const CLUSTER_PROTOCOL_VERSION = 1;

// --- Request / Response types ---

export interface ClusterRequest {
	id: number;
	version: number;
	method: string;
	params: unknown;
	/** Identity of the sender (set by followers). */
	from?: { pid: number; agentId?: string; sessionId?: string };
}

export interface ClusterResponse {
	id: number;
	result?: unknown;
	error?: string;
}

// --- Embedding-specific payloads ---

export interface EmbedBatchParams {
	texts: string[];
}

export interface EmbedBatchResult {
	vectors: number[][];
}

// --- Serialize / Deserialize (length-prefixed JSON over stream) ---

/**
 * Encode a message as a length-prefixed buffer: [4-byte LE length][JSON payload].
 */
export function encodeMessage(msg: ClusterRequest | ClusterResponse): Buffer {
	const json = Buffer.from(JSON.stringify(msg), "utf8");
	const header = Buffer.alloc(4);
	header.writeUInt32LE(json.length, 0);
	return Buffer.concat([header, json]);
}

/**
 * Streaming decoder: feed chunks, get back parsed messages.
 */
export class MessageDecoder {
	private buf = Buffer.alloc(0);

	feed(chunk: Buffer): (ClusterRequest | ClusterResponse)[] {
		this.buf = Buffer.concat([this.buf, chunk]);
		const messages: (ClusterRequest | ClusterResponse)[] = [];
		while (this.buf.length >= 4) {
			const len = this.buf.readUInt32LE(0);
			if (this.buf.length < 4 + len) break;
			const json = this.buf.subarray(4, 4 + len).toString("utf8");
			this.buf = this.buf.subarray(4 + len);
			messages.push(JSON.parse(json));
		}
		return messages;
	}
}