function isHighSurrogate(codeUnit: number): boolean {
	return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
	return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function sliceUtf16Safe(input: string, from: number, to: number): string {
	const len = input.length;
	let start = Math.max(0, Math.min(len, Math.floor(from)));
	let end = Math.max(0, Math.min(len, Math.floor(to)));

	if (start > 0 && start < len) {
		const codeUnit = input.charCodeAt(start);
		if (isLowSurrogate(codeUnit) && isHighSurrogate(input.charCodeAt(start - 1))) {
			start += 1;
		}
	}

	if (end > 0 && end < len) {
		const codeUnit = input.charCodeAt(end - 1);
		if (isHighSurrogate(codeUnit) && isLowSurrogate(input.charCodeAt(end))) {
			end -= 1;
		}
	}

	return input.slice(start, end);
}

export function truncateUtf16Safe(input: string, maxLen: number): string {
	const limit = Math.max(0, Math.floor(maxLen));
	if (input.length <= limit) return input;
	return sliceUtf16Safe(input, 0, limit);
}