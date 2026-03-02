import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";

const DESCRIPTION = `Collect structured multiple-choice answers from the user.
Provide one or more questions with options, and set \`allow_multiple\` when multi-select is appropriate.

Use this tool when you need to gather specific information from the user through a structured question format.
Each question should have:
- A unique id (used to match answers)
- A clear prompt/question text
- At least 2 options for the user to choose from
- An optional allow_multiple flag (defaults to false for single-select)

By default, the tool presents questions in an interactive selector and waits for answers.

Interactive behavior:
- Use ↑/↓ to move between options
- Use Space to toggle selection on/off
- Use Enter to submit current question
- Use Esc to cancel
- For single-select questions, selection is exclusive (selecting one option clears previous selection)`

const optionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this option" }),
	label: Type.String({ description: "Display text for this option" }),
});

const questionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	prompt: Type.String({ description: "The question text to display to the user" }),
	options: Type.Array(optionSchema, {
		description: "Array of answer options (minimum 2 required)",
		minItems: 2,
	}),
	allow_multiple: Type.Optional(
		Type.Boolean({
			description: "If true, user can select multiple options. Defaults to false.",
		}),
	),
});

const askQuestionSchema = Type.Object({
	title: Type.Optional(Type.String({ description: "Optional title for the questions form" })),
	questions: Type.Array(questionSchema, {
		description: "Array of questions to present to the user (minimum 1 required)",
		minItems: 1,
	}),
});

type AskQuestionInput = Static<typeof askQuestionSchema>;

interface AskAnswer {
	question_id: string;
	selected_option_ids: string[];
}

interface AskQuestionDetails {
	title?: string;
	has_ui: boolean;
	cancelled?: boolean;
	answered_questions: number;
	total_questions: number;
	answers: AskAnswer[];
	reason?: string;
}

function validateQuestions(input: AskQuestionInput): void {
	const questionIds = new Set<string>();

	for (const question of input.questions) {
		const questionId = question.id.trim();
		if (questionId.length === 0) {
			throw new Error("Question id cannot be empty.");
		}
		if (questionIds.has(questionId)) {
			throw new Error(`Duplicate question id: ${questionId}`);
		}
		questionIds.add(questionId);

		if (question.prompt.trim().length === 0) {
			throw new Error(`Question prompt cannot be empty (id: ${questionId}).`);
		}

		const optionIds = new Set<string>();
		for (const option of question.options) {
			const optionId = option.id.trim();
			if (optionId.length === 0) {
				throw new Error(`Option id cannot be empty (question: ${questionId}).`);
			}
			if (optionIds.has(optionId)) {
				throw new Error(`Duplicate option id in question ${questionId}: ${optionId}`);
			}
			optionIds.add(optionId);

			if (option.label.trim().length === 0) {
				throw new Error(`Option label cannot be empty (question: ${questionId}, option: ${optionId}).`);
			}
		}
	}
}

function formatOptionDisplay(index: number, label: string, id: string): string {
	return `${index + 1}. ${label} [${id}]`;
}

function formatQuestionTitle(baseTitle: string | undefined, questionIndex: number, totalQuestions: number, prompt: string): string {
	const title = baseTitle && baseTitle.trim().length > 0 ? baseTitle.trim() : "Please answer the following question";
	return `${title} (${questionIndex + 1}/${totalQuestions})\n\n${prompt}`;
}

interface SelectionResult {
	selected_option_ids: string[];
}

function getSelectedOptionIdsInDisplayOrder(
	options: AskQuestionInput["questions"][number]["options"],
	selectedIds: ReadonlySet<string>,
): string[] {
	return options.filter((option) => selectedIds.has(option.id)).map((option) => option.id);
}

async function askQuestionWithToggleSelection(
	baseTitle: string | undefined,
	question: AskQuestionInput["questions"][number],
	questionIndex: number,
	totalQuestions: number,
	_signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<string[] | undefined> {
	const modeHint = question.allow_multiple ? "Multi-select" : "Single-select (exclusive)";

	const result = await ctx.ui.custom<SelectionResult | null>((tui, theme, _keybindings, done) => {
		let optionIndex = 0;
		let showEmptySelectionWarning = false;
		let cachedLines: string[] | undefined;
		const selectedIds = new Set<string>();

		const refresh = () => {
			cachedLines = undefined;
			tui.requestRender();
		};

		const toggleOption = (index: number) => {
			const option = question.options[index];
			if (!option) return;

			if (question.allow_multiple) {
				if (selectedIds.has(option.id)) {
					selectedIds.delete(option.id);
				} else {
					selectedIds.add(option.id);
				}
			} else {
				if (selectedIds.has(option.id)) {
					selectedIds.clear();
				} else {
					selectedIds.clear();
					selectedIds.add(option.id);
				}
			}

			showEmptySelectionWarning = false;
			refresh();
		};

		const submitSelection = () => {
			const selectedOptionIds = getSelectedOptionIdsInDisplayOrder(question.options, selectedIds);
			if (selectedOptionIds.length === 0) {
				showEmptySelectionWarning = true;
				refresh();
				return;
			}
			done({ selected_option_ids: selectedOptionIds });
		};

		const render = (width: number): string[] => {
			if (cachedLines) return cachedLines;

			const lines: string[] = [];
			const add = (line: string) => lines.push(truncateToWidth(line, width));
			const questionTitleLines = formatQuestionTitle(baseTitle, questionIndex, totalQuestions, question.prompt).split("\n");

			add(theme.fg("accent", "─".repeat(Math.max(12, width))));
			for (const titleLine of questionTitleLines) {
				add(theme.fg("accent", titleLine));
			}
			add(theme.fg("muted", modeHint));
			lines.push("");

			for (let i = 0; i < question.options.length; i++) {
				const option = question.options[i];
				const isActive = i === optionIndex;
				const isSelected = selectedIds.has(option.id);
				const cursor = isActive ? theme.fg("accent", ">") : " ";
				const marker = isSelected ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
				const label = isActive
					? theme.fg("accent", formatOptionDisplay(i, option.label, option.id))
					: theme.fg("text", formatOptionDisplay(i, option.label, option.id));
				add(`${cursor} ${marker} ${label}`);
			}

			lines.push("");
			const selectedSummary = getSelectedOptionIdsInDisplayOrder(question.options, selectedIds);
			if (selectedSummary.length === 0) {
				add(theme.fg("muted", "Selected: (none)"));
			} else {
				add(theme.fg("muted", `Selected: ${selectedSummary.join(", ")}`));
			}

			if (showEmptySelectionWarning) {
				add(theme.fg("warning", "Please select at least one option before submitting."));
			}

			lines.push("");
			add(theme.fg("dim", "↑↓ navigate • Space toggle • Enter submit • Esc cancel"));
			add(theme.fg("accent", "─".repeat(Math.max(12, width))));

			cachedLines = lines;
			return lines;
		};

		const handleInput = (data: string) => {
			if (matchesKey(data, Key.up) || data === "k") {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down) || data === "j") {
				optionIndex = Math.min(question.options.length - 1, optionIndex + 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.space)) {
				toggleOption(optionIndex);
				return;
			}
			if (matchesKey(data, Key.enter)) {
				submitSelection();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				done(null);
			}
		};

		return {
			render,
			handleInput,
			invalidate: () => {
				cachedLines = undefined;
			},
		};
	});

	if (!result) {
		return undefined;
	}

	return result.selected_option_ids;
}

function buildSuccessText(answers: AskAnswer[], questions: AskQuestionInput["questions"]): string {
	const lines: string[] = [`Collected answers for ${answers.length} question(s):`];

	for (const answer of answers) {
		const question = questions.find((entry) => entry.id === answer.question_id);
		const labels = answer.selected_option_ids.map((selectedId) => {
			const option = question?.options.find((entry) => entry.id === selectedId);
			return option ? `${selectedId} (${option.label})` : selectedId;
		});
		lines.push(`- ${answer.question_id}: ${labels.join(", ")}`);
	}

	return lines.join("\n");
}

export default function askQuestionExtension(pi: ExtensionAPI) {
	// System prompt injection is handled centrally by system-prompt extension.

	pi.registerTool({
		name: "AskQuestion",
		label: "AskQuestion",
		description: DESCRIPTION,
		parameters: askQuestionSchema,
		async execute(_toolCallId, params: AskQuestionInput, signal, _onUpdate, ctx) {
			validateQuestions(params);

			const totalQuestions = params.questions.length;
			const formTitle = params.title?.trim();
			const normalizedTitle = formTitle && formTitle.length > 0 ? formTitle : undefined;
			const answers: AskAnswer[] = [];

			if (!ctx.hasUI) {
				const reason = "AskQuestion requires interactive UI (not available in current mode).";
				return {
					content: [{ type: "text", text: reason }],
					details: {
						title: normalizedTitle,
						has_ui: false,
						cancelled: true,
						answered_questions: 0,
						total_questions: totalQuestions,
						answers,
						reason,
					} satisfies AskQuestionDetails,
				};
			}

			for (let i = 0; i < totalQuestions; i++) {
				const question = params.questions[i];
				const selectedOptionIds = await askQuestionWithToggleSelection(
					normalizedTitle,
					question,
					i,
					totalQuestions,
					signal,
					ctx,
				);

				if (!selectedOptionIds || selectedOptionIds.length === 0) {
					const answeredQuestions = answers.length;
					const reason =
						answeredQuestions === 0
							? "Question flow cancelled by user before any answer was submitted."
							: `Question flow cancelled by user after ${answeredQuestions} of ${totalQuestions} question(s).`;
					return {
						content: [{ type: "text", text: reason }],
						details: {
							title: normalizedTitle,
							has_ui: true,
							cancelled: true,
							answered_questions: answeredQuestions,
							total_questions: totalQuestions,
							answers,
							reason,
						} satisfies AskQuestionDetails,
					};
				}

				answers.push({
					question_id: question.id,
					selected_option_ids: selectedOptionIds,
				});
			}

			return {
				content: [{ type: "text", text: buildSuccessText(answers, params.questions) }],
				details: {
					title: normalizedTitle,
					has_ui: true,
					answered_questions: answers.length,
					total_questions: totalQuestions,
					answers,
				} satisfies AskQuestionDetails,
			};
		},
	});
}