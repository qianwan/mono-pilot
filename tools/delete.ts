import type { Stats } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";

// Tool docs are surfaced via system-prompt extension functions namespace.

const deleteSchema = Type.Object({
	path: Type.String({
		description: "The absolute path of the file to delete",
	}),
});

type DeleteInput = Static<typeof deleteSchema>;
type DeleteStatus = "deleted" | "not_found" | "security_rejected" | "not_file" | "error";

interface DeleteDetails {
	status: DeleteStatus;
	requested_path: string;
	resolved_path: string;
	reason?: string;
}

function resolveTargetPath(inputPath: string, workspaceCwd: string): string {
	const trimmed = inputPath.trim();
	if (trimmed.length === 0) {
		throw new Error("Path is required.");
	}
	return isAbsolute(trimmed) ? resolve(trimmed) : resolve(workspaceCwd, trimmed);
}

function isInsideWorkspace(targetPath: string, workspaceCwd: string): boolean {
	const rel = relative(resolve(workspaceCwd), targetPath);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

export default function (pi: ExtensionAPI) {
	// System prompt injection is handled centrally by system-prompt extension.

	pi.registerTool({
		name: "Delete",
		label: "Delete",
		description: "Delete file at specified path relative to workspace root; fails gracefully if file doesn't exist, security rejection, or undeletable.",
		parameters: deleteSchema,
		async execute(_toolCallId, params: DeleteInput, _signal, _onUpdate, ctx) {
			const requestedPath = params.path;
			let resolvedPath: string;

			try {
				resolvedPath = resolveTargetPath(requestedPath, ctx.cwd);
			} catch (error) {
				const details: DeleteDetails = {
					status: "error",
					requested_path: requestedPath,
					resolved_path: "",
					reason: errorMessage(error),
				};
				return {
					content: [{ type: "text", text: details.reason ?? "Invalid path." }],
					details,
				};
			}

			if (!isInsideWorkspace(resolvedPath, ctx.cwd)) {
				const details: DeleteDetails = {
					status: "security_rejected",
					requested_path: requestedPath,
					resolved_path: resolvedPath,
					reason: "Security rejection: path is outside workspace root.",
				};
				return {
					content: [{ type: "text", text: details.reason ?? "Security rejection." }],
					details,
				};
			}

			let targetStat: Stats;
			try {
				targetStat = await stat(resolvedPath);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT") {
					const details: DeleteDetails = {
						status: "not_found",
						requested_path: requestedPath,
						resolved_path: resolvedPath,
						reason: "File does not exist.",
					};
					return {
						content: [{ type: "text", text: details.reason ?? "File does not exist." }],
						details,
					};
				}
				const details: DeleteDetails = {
					status: "error",
					requested_path: requestedPath,
					resolved_path: resolvedPath,
					reason: `Unable to inspect path: ${errorMessage(error)}`,
				};
				return {
					content: [{ type: "text", text: details.reason ?? "Unable to inspect path." }],
					details,
				};
			}

			if (!targetStat.isFile()) {
				const details: DeleteDetails = {
					status: "not_file",
					requested_path: requestedPath,
					resolved_path: resolvedPath,
					reason: "Only regular files can be deleted with this tool.",
				};
				return {
					content: [{ type: "text", text: details.reason ?? "Only regular files can be deleted with this tool." }],
					details,
				};
			}

			try {
				await unlink(resolvedPath);
				const details: DeleteDetails = {
					status: "deleted",
					requested_path: requestedPath,
					resolved_path: resolvedPath,
				};
				return {
					content: [{ type: "text", text: `Deleted file: ${resolvedPath}` }],
					details,
				};
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				const status: DeleteStatus = code === "ENOENT" ? "not_found" : "error";
				const reason = code === "ENOENT" ? "File does not exist." : `Failed to delete file: ${errorMessage(error)}`;
				const details: DeleteDetails = {
					status,
					requested_path: requestedPath,
					resolved_path: resolvedPath,
					reason,
				};
				return {
					content: [{ type: "text", text: reason }],
					details,
				};
			}
		},
	});
}
