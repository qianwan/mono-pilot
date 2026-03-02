import { describe, it, expect } from "vitest";
import { __test__ } from "./rg.js";

const { applyPagination, parseContentEvents, buildRgArgs, resolveMonopilotIgnorePath } = __test__;

describe("rg tool helpers", () => {
	it("content mode paginates by match entries with context", () => {
		const stdout = [
			JSON.stringify({
				type: "match",
				data: {
					path: { text: "file1" },
					line_number: 1,
					lines: { text: "match" },
				},
			}),
			JSON.stringify({
				type: "context",
				data: {
					path: { text: "file1" },
					line_number: 2,
					lines: { text: "context" },
				},
			}),
			JSON.stringify({
				type: "match",
				data: {
					path: { text: "file1" },
					line_number: 5,
					lines: { text: "match" },
				},
			}),
		].join("\n");

		const parsed = parseContentEvents(stdout, 0, 0);
		const { pagedEntries, totalAfterOffset } = applyPagination(parsed.entries, 0, 10);

		expect(pagedEntries.length).toBe(2);
		expect(totalAfterOffset).toBe(2);
		expect(pagedEntries[0]).toContain("file1:1:match");
		expect(pagedEntries[1]).toContain("file1:5:match");
	});

	it("multiline match is kept as one content entry", () => {
		const stdout = [
			JSON.stringify({
				type: "match",
				data: {
					path: { text: "file1" },
					line_number: 1,
					lines: { text: "match start\nmatch line 2\nmatch end" },
				},
			}),
		].join("\n");

		const parsed = parseContentEvents(stdout, 0, 0);
		const { pagedEntries } = applyPagination(parsed.entries, 0, 10);

		expect(pagedEntries.length).toBe(1);
		expect(pagedEntries[0]).toContain("file1:1:match start");
		expect(pagedEntries[0]).toContain("file1:2:match line 2");
		expect(pagedEntries[0]).toContain("file1:3:match end");
	});

	it("head_limit=0 does not incorrectly report no matches", () => {
		const entries = ["one", "two"];
		const { pagedEntries, totalAfterOffset } = applyPagination(entries, 0, 0);
		expect(pagedEntries.length).toBe(0);
		expect(totalAfterOffset).toBe(2);
	});

	it("respects .monopilotignore in files_with_matches mode", () => {
		const args = buildRgArgs(
			{
				pattern: "test",
				path: process.cwd(),
				output_mode: "files_with_matches",
			} as any,
			"files_with_matches",
			process.cwd(),
			process.cwd(),
		);

		const ignorePath = resolveMonopilotIgnorePath(process.cwd());
		if (ignorePath) {
			expect(args).toContain("--ignore-file");
			expect(args).toContain(ignorePath);
		} else {
			expect(args).not.toContain("--ignore-file");
		}
	});
});
