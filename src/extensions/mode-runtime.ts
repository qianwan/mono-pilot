export const MODE_STATE_ENTRY_TYPE = "switch-mode-state";

export type ModeId = "plan" | "agent" | "ask";
export type PendingReminder = "plan-entry" | "agent-entry" | "ask-entry";

export interface ModeStateSnapshot {
	activeMode: ModeId;
	pendingReminder?: PendingReminder;
}

export interface ModeStateData {
	activeMode?: ModeId;
	pendingReminder?: PendingReminder;
	// Backward compatibility with earlier local state shape
	planModeActive?: boolean;
}

export const PLAN_MODE_STILL_ACTIVE_REMINDER = `<system_reminder>
Plan mode is still active. Continue with the task in the current mode.
</system_reminder>`;

export const AGENT_MODE_SWITCH_REMINDER = `<system_reminder>
You are now in Agent mode. Continue with the task in the new mode.
</system_reminder>`;

export const ASK_MODE_SWITCH_REMINDER = `<system_reminder>
You are now in Ask mode. Continue with the task in the new mode.
</system_reminder>`;

export const ASK_MODE_STILL_ACTIVE_REMINDER = `<system_reminder>
Ask mode is still active. Continue with the task in the current mode.
</system_reminder>`;

export function parseModeStateEntry(entry: unknown): ModeStateSnapshot | undefined {
	if (typeof entry !== "object" || entry === null) return undefined;
	const record = entry as Record<string, unknown>;
	if (record.type !== "custom") return undefined;
	if (record.customType !== MODE_STATE_ENTRY_TYPE) return undefined;

	const data = record.data;
	if (typeof data !== "object" || data === null) return undefined;
	const state = data as ModeStateData;

	if (state.activeMode === "plan" || state.activeMode === "agent" || state.activeMode === "ask") {
		return {
			activeMode: state.activeMode,
			pendingReminder:
				state.pendingReminder === "plan-entry" ||
				state.pendingReminder === "agent-entry" ||
				state.pendingReminder === "ask-entry"
					? state.pendingReminder
					: undefined,
		};
	}

	if (typeof state.planModeActive === "boolean") {
		return {
			activeMode: state.planModeActive ? "plan" : "agent",
			pendingReminder: undefined,
		};
	}

	return undefined;
}

export function deriveInitialModeState(fromPlanFlag: boolean): ModeStateSnapshot {
	if (fromPlanFlag) {
		return { activeMode: "plan", pendingReminder: "plan-entry" };
	}
	return { activeMode: "agent" };
}

export function createModeStateData(snapshot: ModeStateSnapshot): ModeStateData {
	return {
		activeMode: snapshot.activeMode,
		pendingReminder: snapshot.pendingReminder,
		planModeActive: snapshot.activeMode === "plan",
	};
}

export function hasMessageEntries(entries: unknown[]): boolean {
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		if (record.type === "message") return true;
	}
	return false;
}

export function buildRuntimeEnvelope(
	userQuery: string,
	reminder: string | undefined,
	mcpInstructions: string | undefined,
	rulesEnvelope: string | undefined,
	briefReminder: string | undefined,
): string {
	const sections: string[] = [];
	if (rulesEnvelope) {
		sections.push(rulesEnvelope.trim());
	}
	if (mcpInstructions) {
		sections.push(mcpInstructions.trim());
	}
	if (reminder) {
		sections.push(reminder.trim());
	}
	if (briefReminder) {
		sections.push(briefReminder.trim());
	}
	sections.push(`<user_query>\n${userQuery}\n</user_query>`);
	return sections.join("\n\n");
}

class ModeRuntimeStore {
	private state: ModeStateSnapshot = { activeMode: "agent" };

	initialize(snapshot: ModeStateSnapshot): void {
		this.state = { ...snapshot };
	}

	getSnapshot(): ModeStateSnapshot {
		return { ...this.state };
	}

	setMode(nextMode: ModeId): { changed: boolean; snapshot: ModeStateSnapshot } {
		if (this.state.activeMode === nextMode) {
			return { changed: false, snapshot: this.getSnapshot() };
		}

		this.state.activeMode = nextMode;
		switch (nextMode) {
			case "plan":
				this.state.pendingReminder = "plan-entry";
				break;
			case "ask":
				this.state.pendingReminder = "ask-entry";
				break;
			case "agent":
			default:
				this.state.pendingReminder = "agent-entry";
				break;
		}
		return { changed: true, snapshot: this.getSnapshot() };
	}

	toggleMode(): { changed: boolean; snapshot: ModeStateSnapshot } {
		let nextMode: ModeId;
		switch (this.state.activeMode) {
			case "agent":
				nextMode = "plan";
				break;
			case "plan":
				nextMode = "ask";
				break;
			case "ask":
			default:
				nextMode = "agent";
				break;
		}
		return this.setMode(nextMode);
	}

	consumeReminder(
		planEntryReminder: string,
		askEntryReminder: string,
	): { reminder: string | undefined; changed: boolean; snapshot: ModeStateSnapshot } {
		if (this.state.activeMode === "plan") {
			if (this.state.pendingReminder === "plan-entry") {
				this.state.pendingReminder = undefined;
				return {
					reminder: planEntryReminder,
					changed: true,
					snapshot: this.getSnapshot(),
				};
			}
			return {
				reminder: PLAN_MODE_STILL_ACTIVE_REMINDER,
				changed: false,
				snapshot: this.getSnapshot(),
			};
		}

		if (this.state.activeMode === "ask") {
			if (this.state.pendingReminder === "ask-entry") {
				this.state.pendingReminder = undefined;
				return {
					reminder: askEntryReminder,
					changed: true,
					snapshot: this.getSnapshot(),
				};
			}
			return {
				reminder: ASK_MODE_STILL_ACTIVE_REMINDER,
				changed: false,
				snapshot: this.getSnapshot(),
			};
		}

		if (this.state.pendingReminder === "agent-entry") {
			this.state.pendingReminder = undefined;
			return {
				reminder: AGENT_MODE_SWITCH_REMINDER,
				changed: true,
				snapshot: this.getSnapshot(),
			};
		}

		return {
			reminder: undefined,
			changed: false,
			snapshot: this.getSnapshot(),
		};
	}
}

export const modeRuntimeStore = new ModeRuntimeStore();
