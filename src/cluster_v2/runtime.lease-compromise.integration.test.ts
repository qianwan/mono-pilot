import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
	listenCalls: 0,
	compromiseTriggered: false,
}));

vi.mock("../memory/embeddings/local.js", () => ({
	createLocalEmbeddingProvider: async (params: { modelPath?: string }) => ({
		id: "local" as const,
		model: params.modelPath ?? "mock-local",
		embedQuery: async (text: string) => [text.length],
		embedBatch: async (texts: string[]) => texts.map((text) => [text.length]),
		dispose: async () => {
			// no-op in tests
		},
	}),
}));

vi.mock("./connection.js", () => ({
	tryConnect: async () => null,
	tryListen: async (options?: { onLeaseCompromised?: (error: Error) => void }) => {
		harness.listenCalls++;

		const server = net.createServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolve());
		});

		let closed = false;
		const close = async () => {
			if (closed) {
				return;
			}
			closed = true;
			await new Promise<void>((resolve) => server.close(() => resolve()));
		};

		if (!harness.compromiseTriggered) {
			harness.compromiseTriggered = true;
			setTimeout(() => {
				options?.onLeaseCompromised?.(new Error("lease compromised in test"));
			}, 15);
		}

		return {
			socketPath: `mock-socket-${harness.listenCalls}`,
			server,
			close,
		};
	},
}));

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
	condition: () => Promise<boolean> | boolean,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) {
			return;
		}
		await sleep(20);
	}
	throw new Error("waitFor timeout");
}

afterEach(async () => {
	const runtime = await import("./runtime.js");
	await runtime.closeClusterV2();
	harness.listenCalls = 0;
	harness.compromiseTriggered = false;
});

describe("cluster_v2 runtime lease compromise integration", () => {
	it("steps down and re-elects when lease is compromised", async () => {
		const runtime = await import("./runtime.js");
		const params = {
			agentId: "lease-agent",
			displayName: "Lease Agent",
			scope: `lease-scope-${process.pid}-${Date.now()}`,
			modelPath: "mock-local",
			rpcTimeoutMs: 500,
			getSessionId: () => "lease-session",
		};

		const first = await runtime.initClusterV2(params);
		expect(first.role).toBe("leader");

		await waitFor(async () => {
			const current = await runtime.initClusterV2(params);
			return current.role === "leader" && current !== first;
		}, 3000);

		const second = await runtime.initClusterV2(params);
		expect(second.role).toBe("leader");
		expect(second).not.toBe(first);
		expect(harness.listenCalls).toBeGreaterThanOrEqual(2);

		const embedding = await second.embedding.embedQuery("ok");
		expect(embedding).toEqual([2]);
	});
});
