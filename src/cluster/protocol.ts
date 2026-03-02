/** Wire protocol for cluster IPC over Unix domain socket. */

export const CLUSTER_PROTOCOL_VERSION = 2;

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

// --- Server Push (leader → follower, unsolicited) ---

export interface ClusterPush {
	type: "push";
	method: string;
	payload: unknown;
}

/** Any message that can appear on the wire. */
export type ClusterMessage = ClusterRequest | ClusterResponse | ClusterPush;

export function isPush(msg: ClusterMessage): msg is ClusterPush {
	return "type" in msg && (msg as ClusterPush).type === "push";
}

// --- Embedding-specific payloads ---

export interface EmbedBatchParams {
	texts: string[];
}

export interface EmbedBatchResult {
	vectors: number[][];
}

// --- Bus RPC params (follower → leader) ---

export interface RegisterParams {
	agentId: string;
	channels?: string[];
}

export interface SendParams {
	to: string;
	channel?: string;
	payload: unknown;
}

export interface BroadcastParams {
	channel?: string;
	payload: unknown;
}

export interface SubscribeParams {
	channels: string[];
}

// --- Push payloads (leader → follower) ---

export interface MessagePushPayload {
	from: string;
	channel?: string;
	payload: unknown;
	seq: number;
}

export interface PresencePushPayload {
	agentId: string;
	status: "joined" | "left";
}

// --- Serialize / Deserialize (length-prefixed JSON over stream) ---

/**
 * Encode a message as a length-prefixed buffer: [4-byte LE length][JSON payload].
 */
export function encodeMessage(msg: ClusterMessage): Buffer {
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

	feed(chunk: Buffer): ClusterMessage[] {
		this.buf = Buffer.concat([this.buf, chunk]);
		const messages: ClusterMessage[] = [];
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