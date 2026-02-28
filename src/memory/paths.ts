import { homedir } from "node:os";
import { join } from "node:path";

export function getMemoryRootDir(): string {
	return join(homedir(), ".mono-pilot", "memory");
}

export function getMemoryIndexPath(): string {
	return join(getMemoryRootDir(), "index.sqlite");
}

export function getMemoryLogsDir(): string {
	return join(homedir(), ".mono-pilot", "logs");
}

export function getMemoryLogPath(date = new Date()): string {
	const stamp = date.toISOString().slice(0, 10);
	return join(getMemoryLogsDir(), `memory.${stamp}.log`);
}