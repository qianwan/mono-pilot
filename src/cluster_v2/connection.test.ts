import net from "node:net";
import { describe, expect, it } from "vitest";
import { tryListen } from "./connection.js";

function uniqueScope(prefix: string): string {
	return `${prefix}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectFollower(socketPath: string): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		socket.once("connect", () => resolve(socket));
		socket.once("error", reject);
	});
}

describe("cluster_v2 connection lease", () => {
	it("allows only one active leader per scope at a time", async () => {
		const scope = uniqueScope("leader-scope");

		const first = await tryListen({ scope });
		expect(first).not.toBeNull();
		if (!first) return;

		const second = await tryListen({ scope });
		expect(second).toBeNull();

		await first.close();

		const third = await tryListen({ scope });
		expect(third).not.toBeNull();
		if (third) {
			await third.close();
		}
	});

	it("closes promptly even with active follower sockets", async () => {
		const scope = uniqueScope("leader-close");
		const leader = await tryListen({ scope });
		expect(leader).not.toBeNull();
		if (!leader) return;

		const follower = await connectFollower(leader.socketPath);
		const followerClosed = new Promise<void>((resolve) => {
			follower.once("close", () => resolve());
		});
		const closeResult = await Promise.race([
			leader.close().then(() => "closed" as const),
			sleep(1000).then(() => "timeout" as const),
		]);

		expect(closeResult).toBe("closed");
		await Promise.race([
			followerClosed.then(() => "closed" as const),
			sleep(1000).then(() => "timeout" as const),
		]).then((result) => {
			expect(result).toBe("closed");
		});
	});
});
