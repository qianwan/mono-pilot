export interface ClusterV2LeaderOfflineEvent {
	agentId: string;
	sessionId?: string;
	scope: string;
	reason: "follower_disconnect";
}

export interface ClusterV2LeaderRecoveredEvent {
	agentId: string;
	sessionId?: string;
	scope: string;
	role: "leader" | "follower";
}

export interface ClusterV2DiscordChannelBatchEvent {
	scope: string;
	channelId: string;
	channelAlias?: string;
	channelName?: string;
	guildName?: string;
	count: number;
	sequence: number;
}

type ClusterV2LeaderOfflineHandler = (event: ClusterV2LeaderOfflineEvent) => void;
type ClusterV2LeaderRecoveredHandler = (event: ClusterV2LeaderRecoveredEvent) => void;
type ClusterV2DiscordChannelBatchHandler = (event: ClusterV2DiscordChannelBatchEvent) => void;

const leaderOfflineHandlers = new Set<ClusterV2LeaderOfflineHandler>();
const leaderRecoveredHandlers = new Set<ClusterV2LeaderRecoveredHandler>();
const discordChannelBatchHandlers = new Set<ClusterV2DiscordChannelBatchHandler>();

export function onClusterV2LeaderOffline(handler: ClusterV2LeaderOfflineHandler): () => void {
	leaderOfflineHandlers.add(handler);
	return () => {
		leaderOfflineHandlers.delete(handler);
	};
}

export function onClusterV2LeaderRecovered(handler: ClusterV2LeaderRecoveredHandler): () => void {
	leaderRecoveredHandlers.add(handler);
	return () => {
		leaderRecoveredHandlers.delete(handler);
	};
}

export function onClusterV2DiscordChannelBatch(
	handler: ClusterV2DiscordChannelBatchHandler,
): () => void {
	discordChannelBatchHandlers.add(handler);
	return () => {
		discordChannelBatchHandlers.delete(handler);
	};
}

export function emitClusterV2LeaderOffline(event: ClusterV2LeaderOfflineEvent): void {
	for (const handler of leaderOfflineHandlers) {
		try {
			handler(event);
		} catch {
			// Best-effort notification only.
		}
	}
}

export function emitClusterV2LeaderRecovered(event: ClusterV2LeaderRecoveredEvent): void {
	for (const handler of leaderRecoveredHandlers) {
		try {
			handler(event);
		} catch {
			// Best-effort notification only.
		}
	}
}

export function emitClusterV2DiscordChannelBatch(event: ClusterV2DiscordChannelBatchEvent): void {
	for (const handler of discordChannelBatchHandlers) {
		try {
			handler(event);
		} catch {
			// Best-effort notification only.
		}
	}
}