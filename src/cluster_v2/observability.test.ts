import { describe, expect, it, vi } from "vitest";
import { createClusterLogContext, RequestCounters } from "./observability.js";

describe("cluster_v2 observability", () => {
	it("builds structured log context with required fields", () => {
		const ctx = createClusterLogContext({
			agentId: "agent-a",
			sessionId: "session-a",
			scope: "scope-a",
			role: "test",
		});

		expect(ctx.pid).toBeGreaterThan(0);
		expect(ctx.agentId).toBe("agent-a");
		expect(ctx.sessionId).toBe("session-a");
		expect(ctx.scope).toBe("scope-a");
		expect(ctx.role).toBe("test");
	});

	it("warns on request counter mismatch", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
			// mute test logs
		});
		try {
			const counters = new RequestCounters();
			counters.start();
			counters.assertConsistency(0, createClusterLogContext({ role: "test" }), "mismatch_case");
			expect(warnSpy).toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("stays silent when request counters are consistent", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
			// mute test logs
		});
		try {
			const counters = new RequestCounters();
			counters.start();
			counters.complete("ok");
			counters.assertConsistency(0, createClusterLogContext({ role: "test" }), "consistent_case");
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});
});
