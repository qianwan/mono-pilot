export type ConnectionLifecycleState =
	| "disconnected"
	| "connecting"
	| "connected"
	| "reconnecting"
	| "closed";

const ALLOWED_TRANSITIONS: Record<ConnectionLifecycleState, Set<ConnectionLifecycleState>> = {
	disconnected: new Set(["connecting", "closed"]),
	connecting: new Set(["connected", "disconnected", "closed"]),
	connected: new Set(["reconnecting", "disconnected", "closed"]),
	reconnecting: new Set(["connecting", "disconnected", "closed"]),
	closed: new Set(["connecting"]),
};

export class ConnectionLifecycleTracker {
	private current: ConnectionLifecycleState;

	constructor(initialState: ConnectionLifecycleState = "disconnected") {
		this.current = initialState;
	}

	state(): ConnectionLifecycleState {
		return this.current;
	}

	transition(next: ConnectionLifecycleState, label: string): void {
		if (next === this.current) {
			return;
		}
		const allowed = ALLOWED_TRANSITIONS[this.current];
		if (!allowed.has(next)) {
			throw new Error(
				`[cluster_v2/lifecycle] invalid transition ${this.current} -> ${next} at ${label}`,
			);
		}
		this.current = next;
	}

	assertOpenImpliesConnected(socketOpen: boolean, label: string): void {
		if (socketOpen && this.current !== "connected") {
			throw new Error(
				`[cluster_v2/lifecycle] socket invariant violated at ${label}: state=${this.current}, socketOpen=${socketOpen}`,
			);
		}
	}
}
