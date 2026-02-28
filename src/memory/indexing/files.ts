import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function isFileMissingError(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export interface MemoryFileEntry {
	path: string;
	absPath: string;
	mtimeMs: number;
	size: number;
	hash: string;
}

export interface MemoryChunk {
	startLine: number;
	endLine: number;
	text: string;
	hash: string;
}

export function hashText(value: string): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizePath(value: string): string {
	return value.replace(/\\/g, "/");
}

export function resolveExtraPaths(workspaceDir: string | undefined, extraPaths?: string[]): string[] {
	if (!extraPaths?.length) return [];
	const resolved = extraPaths
		.map((value) => value.trim())
		.filter(Boolean)
		.map((value) =>
			path.isAbsolute(value)
				? path.resolve(value)
				: workspaceDir
					? path.resolve(workspaceDir, value)
					: path.resolve(value),
		);
	return Array.from(new Set(resolved));
}

async function walkDir(dir: string, files: string[]): Promise<void> {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) {
			await walkDir(full, files);
			continue;
		}
		if (!entry.isFile()) continue;
		if (!entry.name.endsWith(".md")) continue;
		files.push(full);
	}
}

export async function listMemoryFiles(params: {
	memoryDir: string;
	extraPaths?: string[];
	workspaceDir?: string;
}): Promise<string[]> {
	const result: string[] = [];
	try {
		const dirStat = await fs.lstat(params.memoryDir);
		if (!dirStat.isSymbolicLink() && dirStat.isDirectory()) {
			await walkDir(params.memoryDir, result);
		}
	} catch {}

	const normalizedExtraPaths = resolveExtraPaths(params.workspaceDir, params.extraPaths);
	for (const inputPath of normalizedExtraPaths) {
		try {
			const stat = await fs.lstat(inputPath);
			if (stat.isSymbolicLink()) continue;
			if (stat.isDirectory()) {
				await walkDir(inputPath, result);
				continue;
			}
			if (stat.isFile() && inputPath.endsWith(".md")) {
				result.push(inputPath);
			}
		} catch {}
	}

	return Array.from(new Set(result));
}

export async function buildFileEntry(absPath: string): Promise<MemoryFileEntry | null> {
	let stat;
	try {
		stat = await fs.stat(absPath);
	} catch (err) {
		if (isFileMissingError(err)) return null;
		throw err;
	}
	let content: string;
	try {
		content = await fs.readFile(absPath, "utf-8");
	} catch (err) {
		if (isFileMissingError(err)) return null;
		throw err;
	}
	const hash = hashText(content);
	return {
		path: normalizePath(path.resolve(absPath)),
		absPath,
		mtimeMs: stat.mtimeMs,
		size: stat.size,
		hash,
	};
}

export function chunkMarkdown(content: string, chunking: { tokens: number; overlap: number }): MemoryChunk[] {
	const lines = content.split("\n");
	if (lines.length === 0) return [];
	const maxChars = Math.max(32, chunking.tokens * 4);
	const overlapChars = Math.max(0, chunking.overlap * 4);
	const chunks: MemoryChunk[] = [];

	let current: Array<{ line: string; lineNo: number }> = [];
	let currentChars = 0;

	const flush = () => {
		if (current.length === 0) return;
		const firstEntry = current[0];
		const lastEntry = current[current.length - 1];
		if (!firstEntry || !lastEntry) return;
		const text = current.map((entry) => entry.line).join("\n");
		const startLine = firstEntry.lineNo;
		const endLine = lastEntry.lineNo;
		chunks.push({ startLine, endLine, text, hash: hashText(text) });
	};

	const carryOverlap = () => {
		if (overlapChars <= 0 || current.length === 0) {
			current = [];
			currentChars = 0;
			return;
		}
		let acc = 0;
		const kept: Array<{ line: string; lineNo: number }> = [];
		for (let i = current.length - 1; i >= 0; i -= 1) {
			const entry = current[i];
			if (!entry) continue;
			acc += entry.line.length + 1;
			kept.unshift(entry);
			if (acc >= overlapChars) break;
		}
		current = kept;
		currentChars = kept.reduce((sum, entry) => sum + entry.line.length + 1, 0);
	};

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		const lineNo = i + 1;
		const lineSize = line.length + 1;
		if (lineSize > maxChars) {
			if (current.length > 0) {
				flush();
				carryOverlap();
			}
			chunks.push({
				startLine: lineNo,
				endLine: lineNo,
				text: line,
				hash: hashText(line),
			});
			continue;
		}

		if (currentChars + lineSize > maxChars && current.length > 0) {
			flush();
			carryOverlap();
		}
		current.push({ line, lineNo });
		currentChars += lineSize;
	}

	flush();
	return chunks;
}