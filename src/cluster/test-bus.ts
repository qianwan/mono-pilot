#!/usr/bin/env npx tsx
/**
 * Smoke test for the cluster message bus.
 *
 * Starts a leader (with dummy embedding provider), connects two followers
 * as "alice" and "bob", tests register/send/broadcast/presence.
 *
 * Run: npx tsx src/cluster/test-bus.ts
 */

import { tryBecomeLeader } from "./leader.js";
import { createEmbeddingHandler } from "./services/embedding.js";
import { createBusHandler } from "./services/bus.js";
import { tryFollowLeader } from "./follower.js";
import { connectBus } from "./bus.js";
import { cleanupSocket } from "./socket.js";
import type { MessagePushPayload, PresencePushPayload } from "./protocol.js";
import type { EmbeddingProvider } from "../memory/embeddings/types.js";

const dummyProvider: EmbeddingProvider = {
	id: "local",
	model: "test",
	embedQuery: async () => [0],
	embedBatch: async (texts) => texts.map(() => [0]),
};

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
	if (condition) {
		console.log(`  ✅ ${label}`);
		passed++;
	} else {
		console.log(`  ❌ ${label}`);
		failed++;
	}
}

async function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
	console.log("=== Cluster Message Bus Test ===\n");

	// --- Start leader ---
	console.log("Starting leader...");
	const services = [createEmbeddingHandler(dummyProvider), createBusHandler()];
	const leader = await tryBecomeLeader(services);
	assert(leader !== null, "leader started");
	if (!leader) { process.exit(1); }

	// --- Connect Alice ---
	console.log("\nConnecting Alice...");
	const aliceHandle = await tryFollowLeader("test", { agentId: "alice" });
	assert(aliceHandle !== null, "alice connected");
	if (!aliceHandle) { await leader.close(); process.exit(1); }

	// --- Connect Bob ---
	console.log("\nConnecting Bob...");
	const bobHandle = await tryFollowLeader("test", { agentId: "bob" });
	assert(bobHandle !== null, "bob connected");
	if (!bobHandle) { aliceHandle.close(); await leader.close(); process.exit(1); }

	// --- Register on bus ---
	console.log("\nRegistering on bus...");
	const aliceBus = await connectBus(aliceHandle.client, "alice", ["public"]);
	assert(true, "alice registered");

	const presenceEvents: PresencePushPayload[] = [];
	// Alice registers a presence handler to capture bob's join + bob's leave later
	aliceBus.onPresence((evt) => { presenceEvents.push(evt); });

	const bobBus = await connectBus(bobHandle.client, "bob", ["public"]);
	assert(true, "bob registered");

	// Bob registers presence handler synchronously after connectBus —
	// buffered events flush on nextTick, so this handler will catch them.
	const bobPresenceOnJoin: PresencePushPayload[] = [];
	bobBus.onPresence((evt) => { bobPresenceOnJoin.push(evt); });

	await sleep(50);

	// --- Test: late joiner sees existing agents ---
	console.log("\nTest: late joiner sees existing agents...");
	// Alice should have received bob's join
	const aliceSawBobJoin = presenceEvents.some((e) => e.agentId === "bob" && e.status === "joined");
	assert(aliceSawBobJoin, "alice received bob's presence:joined");
	// Bob should know alice was already there
	const bobSawAlice = bobPresenceOnJoin.some((e) => e.agentId === "alice" && e.status === "joined");
	assert(bobSawAlice, "bob received alice's presence:joined on connect");

	// Wire up remaining handlers
	const aliceMessages: MessagePushPayload[] = [];
	const bobMessages: MessagePushPayload[] = [];

	aliceBus.onMessage((msg) => { aliceMessages.push(msg); });
	bobBus.onMessage((msg) => { bobMessages.push(msg); });

	// --- Test: send (alice → bob) ---
	console.log("\nTest: send (alice → bob)...");
	const sendResult = await aliceBus.send("bob", { text: "你昨晚在哪？" });
	assert(typeof sendResult.seq === "number", `send returned seq=${sendResult.seq}`);

	await sleep(50); // let push arrive

	assert(bobMessages.length === 1, `bob received 1 message (got ${bobMessages.length})`);
	if (bobMessages[0]) {
		assert(bobMessages[0].from === "alice", `message from alice`);
		assert((bobMessages[0].payload as any)?.text === "你昨晚在哪？", `message payload correct`);
	}

	// --- Test: send (bob → alice) ---
	console.log("\nTest: send (bob → alice)...");
	await bobBus.send("alice", { text: "我在图书馆" });

	await sleep(50);

	assert(aliceMessages.length === 1, `alice received 1 message (got ${aliceMessages.length})`);
	if (aliceMessages[0]) {
		assert(aliceMessages[0].from === "bob", `message from bob`);
		assert((aliceMessages[0].payload as any)?.text === "我在图书馆", `message payload correct`);
	}

	// --- Test: broadcast ---
	console.log("\nTest: broadcast (alice → public)...");
	const bcResult = await aliceBus.broadcast({ text: "大家注意！" });
	assert(typeof bcResult.seq === "number", `broadcast returned seq=${bcResult.seq}`);
	assert(bcResult.delivered === 1, `broadcast delivered to 1 (got ${bcResult.delivered})`);

	await sleep(50);

	assert(bobMessages.length === 2, `bob received broadcast (total ${bobMessages.length})`);
	if (bobMessages[1]) {
		assert(bobMessages[1].from === "alice", `broadcast from alice`);
		assert(bobMessages[1].channel === "public", `broadcast channel is public`);
	}
	// Alice should NOT receive her own broadcast
	assert(aliceMessages.length === 1, `alice did not receive own broadcast (still ${aliceMessages.length})`);

	// --- Test: subscribe + channel routing ---
	console.log("\nTest: subscribe + channel routing...");
	await bobBus.subscribe(["secret"]);
	await aliceBus.broadcast({ text: "秘密消息" }, "secret");

	await sleep(50);

	// Alice is not subscribed to "secret", so she won't get it either
	// Bob IS subscribed to "secret"
	assert(bobMessages.length === 3, `bob received secret channel message (total ${bobMessages.length})`);
	if (bobMessages[2]) {
		assert(bobMessages[2].channel === "secret", `message on secret channel`);
	}

	// --- Test: send to non-existent agent ---

	// --- Test: private channel (auto-subscribed) ---
	console.log("\nTest: private channel (auto-subscribed)...");
	const bobBefore = bobMessages.length;
	const aliceBefore = aliceMessages.length;
	await aliceBus.broadcast({ text: "只给 bob 看" }, "private:bob");

	await sleep(50);

	assert(bobMessages.length === bobBefore + 1, `bob received private:bob message`);
	if (bobMessages[bobMessages.length - 1]) {
		assert(bobMessages[bobMessages.length - 1].channel === "private:bob", `channel is private:bob`);
	}
	assert(aliceMessages.length === aliceBefore, `alice did NOT receive private:bob message`);

	// --- Test: send to non-existent agent ---
	console.log("\nTest: send to non-existent agent...");
	try {
		await aliceBus.send("charlie", { text: "hello?" });
		assert(false, "should have thrown");
	} catch (err) {
		assert((err as Error).message.includes("not found"), `error: ${(err as Error).message}`);
	}

	// --- Test: presence on disconnect ---
	console.log("\nTest: presence on disconnect...");
	presenceEvents.length = 0;
	bobBus.close();
	bobHandle.close();

	await sleep(100);

	const leftEvent = presenceEvents.find((e) => e.agentId === "bob" && e.status === "left");
	assert(leftEvent !== undefined, `alice received bob's presence:left`);

	// --- Cleanup ---
	console.log("\nCleaning up...");
	aliceBus.close();
	aliceHandle.close();
	await leader.close();

	console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
	process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
	console.error("Test crashed:", err);
	cleanupSocket();
	process.exit(1);
});