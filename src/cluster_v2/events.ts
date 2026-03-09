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

export interface ClusterV2TwitterPullBatchEvent {
	scope: string;
	count: number;
	requestedCount: number;
	sequence: number;
}

export interface ClusterV2TwitterPullFailedEvent {
	scope: string;
	trigger: "startup" | "interval";
	error: string;
}

export interface ClusterV2TwitterCollectorStartupFailedEvent {
	scope: string;
	error: string;
}

type ClusterV2LeaderOfflineHandler = (event: ClusterV2LeaderOfflineEvent) => void;
type ClusterV2LeaderRecoveredHandler = (event: ClusterV2LeaderRecoveredEvent) => void;
type ClusterV2DiscordChannelBatchHandler = (event: ClusterV2DiscordChannelBatchEvent) => void;
type ClusterV2TwitterPullBatchHandler = (event: ClusterV2TwitterPullBatchEvent) => void;
type ClusterV2TwitterPullFailedHandler = (event: ClusterV2TwitterPullFailedEvent) => void;
type ClusterV2TwitterCollectorStartupFailedHandler = (
	event: ClusterV2TwitterCollectorStartupFailedEvent,
) => void;

const leaderOfflineHandlers = new Set<ClusterV2LeaderOfflineHandler>();
const leaderRecoveredHandlers = new Set<ClusterV2LeaderRecoveredHandler>();
const discordChannelBatchHandlers = new Set<ClusterV2DiscordChannelBatchHandler>();
const twitterPullBatchHandlers = new Set<ClusterV2TwitterPullBatchHandler>();
const twitterPullFailedHandlers = new Set<ClusterV2TwitterPullFailedHandler>();
const twitterCollectorStartupFailedHandlers = new Set<ClusterV2TwitterCollectorStartupFailedHandler>();

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

export function onClusterV2TwitterPullBatch(handler: ClusterV2TwitterPullBatchHandler): () => void {
	twitterPullBatchHandlers.add(handler);
	return () => {
		twitterPullBatchHandlers.delete(handler);
	};
}

export function onClusterV2TwitterPullFailed(handler: ClusterV2TwitterPullFailedHandler): () => void {
	twitterPullFailedHandlers.add(handler);
	return () => {
		twitterPullFailedHandlers.delete(handler);
	};
}

export function onClusterV2TwitterCollectorStartupFailed(
	handler: ClusterV2TwitterCollectorStartupFailedHandler,
): () => void {
	twitterCollectorStartupFailedHandlers.add(handler);
	return () => {
		twitterCollectorStartupFailedHandlers.delete(handler);
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

export function emitClusterV2TwitterPullBatch(event: ClusterV2TwitterPullBatchEvent): void {
	for (const handler of twitterPullBatchHandlers) {
		try {
			handler(event);
		} catch {
			// Best-effort notification only.
		}
	}
}

export function emitClusterV2TwitterPullFailed(event: ClusterV2TwitterPullFailedEvent): void {
	for (const handler of twitterPullFailedHandlers) {
		try {
			handler(event);
		} catch {
			// Best-effort notification only.
		}
	}
}

export function emitClusterV2TwitterCollectorStartupFailed(
	event: ClusterV2TwitterCollectorStartupFailedEvent,
): void {
	for (const handler of twitterCollectorStartupFailedHandlers) {
		try {
			handler(event);
		} catch {
			// Best-effort notification only.
		}
	}
}