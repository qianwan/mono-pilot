export function isFileMissingError(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}