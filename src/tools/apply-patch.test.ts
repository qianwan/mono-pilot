import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { alignReplacement, applyPatchToFilesystem } from "./apply-patch.js";

const fixtureRoot = fileURLToPath(new URL("./apply-patch-fixtures", import.meta.url));
const fixtureOriginal = resolve(fixtureRoot, "original.md");
const fixturePatches = resolve(fixtureRoot, "patches");
const fixtureExpected = resolve(fixtureRoot, "expected");
const PATCH_TARGET = "{{FILE}}";

describe("ApplyPatch Robustness - alignReplacement", () => {
	it("should align 2-space indentation to tabs", () => {
		const fileContent = "function test() {\n\t\tfoo();\n\t\tbar();\n}";
		const oldText = "  foo();\n  bar();";
		const newText = "  foo();\n  baz();\n  bar();";

		const result = alignReplacement(fileContent, oldText, newText);
		
		expect(result).not.toBeNull();
		expect(result?.oldText).toBe("\t\tfoo();\n\t\tbar();");
		expect(result?.newText).toBe("\t\tfoo();\n\t\tbaz();\n\t\tbar();");
	});

	it("should align 4-space indentation to 2-space indentation", () => {
		const fileContent = "function test() {\n  foo();\n  bar();\n}";
		const oldText = "    foo();\n    bar();";
		const newText = "    foo();\n    baz();\n    bar();";

		const result = alignReplacement(fileContent, oldText, newText);
		
		expect(result).not.toBeNull();
		expect(result?.oldText).toBe("  foo();\n  bar();");
		expect(result?.newText).toBe("  foo();\n  baz();\n  bar();");
	});

	it("should map complex mixed indentation", () => {
		const fileContent = "\t  foo();\n\t  bar();";
		const oldText = "  foo();\n  bar();";
		const newText = "  foo();\n  baz();\n  bar();";

		const result = alignReplacement(fileContent, oldText, newText);
		
		expect(result).not.toBeNull();
		expect(result?.oldText).toBe("\t  foo();\n\t  bar();");
		expect(result?.newText).toBe("\t  foo();\n\t  baz();\n\t  bar();");
	});

	it("should preserve unmatched indentation in new lines", () => {
		const fileContent = "\tfoo();\n\tbar();";
		const oldText = "  foo();\n  bar();";
		const newText = "  foo();\n    baz();\n  bar();";

		const result = alignReplacement(fileContent, oldText, newText);
		
		expect(result).not.toBeNull();
		expect(result?.oldText).toBe("\tfoo();\n\tbar();");
		expect(result?.newText).toBe("\tfoo();\n    baz();\n\tbar();");
	});

	it("should normalize CRLF line endings", () => {
		const fileContent = "function test() {\r\n\tfoo();\r\n}";
		const oldText = "  foo();";
		const newText = "  bar();";

		const result = alignReplacement(fileContent, oldText, newText);
		
		expect(result).not.toBeNull();
		expect(result?.oldText).toBe("\tfoo();");
		expect(result?.newText).toBe("\tbar();");
	});

	it("should return null if there are multiple ambiguous matches", () => {
		const fileContent = "function a() {\n\tfoo();\n}\nfunction b() {\n\tfoo();\n}";
		const oldText = "  foo();";
		const newText = "  bar();";

		const result = alignReplacement(fileContent, oldText, newText);
		
		expect(result).toBeNull();
	});

	it("should return null if there are no matches", () => {
		const fileContent = "function test() {\n\t\tfoo();\n\t\tbar();\n}";
		const oldText = "  nope();";
		const newText = "  yep();";

		const result = alignReplacement(fileContent, oldText, newText);
		
		expect(result).toBeNull();
	});

	it("should handle empty lines in the middle of code blocks correctly", () => {
		const fileContent = "function test() {\n\tfoo();\n\n\tbar();\n}";
		const oldText = "  foo();\n\n  bar();";
		const newText = "  foo();\n  baz();\n\n  bar();";

		const result = alignReplacement(fileContent, oldText, newText);
		
		expect(result).not.toBeNull();
		expect(result?.oldText).toBe("\tfoo();\n\n\tbar();");
		expect(result?.newText).toBe("\tfoo();\n\tbaz();\n\n\tbar();");
	});

	it("should respect header-bounded search ranges", () => {
		const fileContent = [
			"class Alpha {",
			"  foo();",
			"}",
			"",
			"class Beta {",
			"  foo();",
			"}",
		].join("\n");
		const oldText = "  foo();";
		const newText = "  bar();";

		const result = alignReplacement(fileContent, oldText, newText, { startLine: 4 });
		expect(result).not.toBeNull();
		expect(result?.oldText).toBe("  foo();");
		expect(result?.newText).toBe("  bar();");
	});
});

describe("ApplyPatch fixtures", () => {
	const cases = [
		{
			name: "context-only",
			patch: "00-context-only.patch",
			expected: "00-context-only.md",
		},
		{
			name: "line-hint",
			patch: "01-line-hint.patch",
			expected: "01-line-hint.md",
		},
		{
			name: "line-range",
			patch: "02-line-range.patch",
			expected: "02-line-range.md",
		},
		{
			name: "diff-header",
			patch: "03-diff-header.patch",
			expected: "03-diff-header.md",
		},
	];

	for (const entry of cases) {
		it(`applies fixture patch: ${entry.name}`, async () => {
			const tempDir = await mkdtemp(`${tmpdir()}/apply-patch-fixture-`);
			const targetPath = resolve(tempDir, "target.md");
			const original = await readFile(fixtureOriginal, "utf-8");
			await writeFile(targetPath, original, "utf-8");

			const patchTemplate = await readFile(resolve(fixturePatches, entry.patch), "utf-8");
			const patchText = patchTemplate.replaceAll(PATCH_TARGET, targetPath);

			await applyPatchToFilesystem({
				patchText,
				cwd: tempDir,
				toolCallId: "fixture",
			});

			const expected = await readFile(resolve(fixtureExpected, entry.expected), "utf-8");
			const actual = await readFile(targetPath, "utf-8");
			expect(actual).toBe(expected);
		});
	}
});
