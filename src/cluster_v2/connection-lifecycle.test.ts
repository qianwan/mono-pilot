import { describe, it, expect } from "vitest";
import { ConnectionLifecycleTracker } from "./connection-lifecycle.js";

describe("cluster_v2 connection lifecycle tracker", () => {
	it("accepts valid lifecycle transitions", () => {
		const tracker = new ConnectionLifecycleTracker("disconnected");

		tracker.transition("connecting", "start_connect");
		tracker.transition("connected", "connect_ok");
		tracker.transition("reconnecting", "leader_lost");
		tracker.transition("connecting", "retry_connect");
		tracker.transition("connected", "retry_ok");
		tracker.transition("closed", "shutdown");

		expect(tracker.state()).toBe("closed");
	});

	it("rejects invalid lifecycle transitions", () => {
		const tracker = new ConnectionLifecycleTracker("disconnected");
		expect(() => tracker.transition("connected", "skip_connecting")).toThrow(
			"invalid transition",
		);
	});

	it("enforces socketOpen => connected invariant", () => {
		const tracker = new ConnectionLifecycleTracker("connecting");
		expect(() => tracker.assertOpenImpliesConnected(true, "pre_connect_socket_open")).toThrow(
			"socket invariant violated",
		);

		tracker.transition("connected", "connect_ok");
		expect(() => tracker.assertOpenImpliesConnected(true, "connected_socket_open")).not.toThrow();
	});
});
