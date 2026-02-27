export interface BriefFrontmatter {
	description?: string;
	limit?: number;
}

export interface ParsedBriefFile {
	frontmatter: BriefFrontmatter;
	body: string;
}

/**
 * Parse YAML frontmatter from a brief file.
 * Supports only `description` (string) and `limit` (positive integer).
 */
export function parseFrontmatter(content: string): ParsedBriefFile {
	const trimmed = content.trimStart();
	if (!trimmed.startsWith("---")) {
		return { frontmatter: {}, body: content };
	}

	const endIndex = trimmed.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { frontmatter: {}, body: content };
	}

	const yamlBlock = trimmed.slice(4, endIndex).trim();
	const body = trimmed.slice(endIndex + 4).trimStart();

	const frontmatter: BriefFrontmatter = {};
	for (const line of yamlBlock.split("\n")) {
		const colonIndex = line.indexOf(":");
		if (colonIndex === -1) continue;
		const key = line.slice(0, colonIndex).trim();
		const value = line.slice(colonIndex + 1).trim();
		if (key === "limit") {
			const num = parseInt(value, 10);
			if (!isNaN(num) && num > 0) frontmatter.limit = num;
		} else if (key === "description") {
			frontmatter.description = value;
		}
	}

	return { frontmatter, body };
}

export function serializeWithFrontmatter(frontmatter: BriefFrontmatter, body: string): string {
	const lines: string[] = ["---"];
	if (frontmatter.description) {
		lines.push(`description: ${frontmatter.description}`);
	}
	if (frontmatter.limit !== undefined) {
		lines.push(`limit: ${frontmatter.limit}`);
	}
	lines.push("---");
	if (body.length > 0) {
		lines.push(body);
	}
	return lines.join("\n") + "\n";
}

export function countBodyLines(body: string): number {
	const trimmed = body.trim();
	if (trimmed.length === 0) return 0;
	return trimmed.split("\n").length;
}