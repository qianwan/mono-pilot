const REFLECTION_INTERVAL = 25;
let turnCount = 0;
let pendingCompactionReflection = false;

/** Flag that a compaction just occurred — next turn will get a reflection reminder. */
export function onCompaction(): void {
	pendingCompactionReflection = true;
}

/**
 * Return a reflection reminder if triggered by compaction event
 * or periodic turn interval. Compaction trigger takes priority.
 */
export function getBriefReflectionReminder(): string | undefined {
	turnCount++;

	const triggered = pendingCompactionReflection || turnCount % REFLECTION_INTERVAL === 0;
	if (!triggered) return undefined;

	const source = pendingCompactionReflection ? "post-compaction" : `turn ${turnCount}`;
	pendingCompactionReflection = false;

	return `<brief_reminder>
[${source}] Review this conversation for information worth remembering across sessions. If you learned anything important, use brief_write to update the relevant file:
- User info / preferences -> human/identity.md or human/prefs/
- Project context / architecture -> project/overview.md, project/conventions.md, etc.
- Task progress -> tasks/current.md
Ask yourself: "If I started a new session tomorrow, what from this conversation would I want to remember?"
Keep notes factual and concise. Append new info rather than overwriting existing knowledge.
</brief_reminder>`;
}