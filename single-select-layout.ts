export interface QuestionOption {
	label: string;
	description?: string;
	preview?: string;
}

export interface AnnotatedRow {
	line: string;
	selected: boolean;
	/** True for the free-form row's placeholder text while it holds no draft. */
	placeholder: boolean;
}

export interface RenderSingleSelectRowsParams {
	options: QuestionOption[];
	selectedIndex: number;
	width: number;
	maxRows?: number;
	hideDescriptions?: boolean;
	/** Text the user already typed in the free-form editor, if any. */
	freeformDraft?: string;
}

/** Shown on the numbered free-form row while the user has typed nothing. */
export const FREEFORM_PLACEHOLDER = "Type something.";
/** Hint under the free-form row while it still holds no draft. */
export const FREEFORM_HINT = "Enter a custom response";

function wrapText(text: string, width: number): string[] {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return [""];
	if (width <= 1) return normalized.split("");

	const words = normalized.split(" ");
	const lines: string[] = [];
	let current = "";

	for (const word of words) {
		if (!current) {
			if (word.length <= width) {
				current = word;
			} else {
				for (let i = 0; i < word.length; i += width) {
					lines.push(word.slice(i, i + width));
				}
			}
			continue;
		}

		const candidate = `${current} ${word}`;
		if (candidate.length <= width) {
			current = candidate;
			continue;
		}

		lines.push(current);
		if (word.length <= width) {
			current = word;
		} else {
			current = "";
			for (let i = 0; i < word.length; i += width) {
				const chunk = word.slice(i, i + width);
				if (chunk.length === width || i + width < word.length) lines.push(chunk);
				else current = chunk;
			}
		}
	}

	if (current) lines.push(current);
	return lines;
}

function padLine(prefix: string, content: string): string {
	return `${prefix}${content}`.trimEnd();
}

interface ItemLine {
	text: string;
	placeholder: boolean;
}

interface ItemBlock {
	itemIndex: number;
	lines: ItemLine[];
}

type ListItem =
	| { type: "option"; option: QuestionOption }
	| { type: "freeform"; option: QuestionOption };

function buildItemBlocks(
	options: QuestionOption[],
	width: number,
	selectedIndex: number,
	hideDescriptions = false,
	freeformDraft = "",
): ItemBlock[] {
	const normalizedWidth = Math.max(12, width);
	const draft = freeformDraft.trim();
	// The free-form row is numbered like every other row. Until the user types
	// something it shows a dim placeholder plus a hint, mirroring an empty
	// input field; once a draft exists the row shows that draft instead.
	const allItems: ListItem[] = options.map((option) => ({ type: "option", option }));
	allItems.push({ type: "freeform", option: { label: draft || FREEFORM_PLACEHOLDER } });

	return allItems.map((item, itemIndex) => {
		const pointer = itemIndex === selectedIndex ? "→" : " ";
		const lines: ItemLine[] = [];
		const isFreeform = item.type === "freeform";
		const placeholder = isFreeform && !draft;

		const numberPrefix = `${pointer} ${itemIndex + 1}. `;
		const continuationPrefix = " ".repeat(numberPrefix.length);
		const titleLines = wrapText(item.option.label, Math.max(8, normalizedWidth - numberPrefix.length));
		titleLines.forEach((line, lineIndex) => {
			lines.push({
				text: padLine(lineIndex === 0 ? numberPrefix : continuationPrefix, line),
				placeholder,
			});
		});

		const description = isFreeform ? (placeholder ? FREEFORM_HINT : undefined) : item.option.description;
		if (description && !hideDescriptions) {
			const descriptionPrefix = "      ";
			const descriptionLines = wrapText(
				description,
				Math.max(8, normalizedWidth - descriptionPrefix.length),
			);
			descriptionLines.forEach((line) => {
				// The free-form hint belongs to the empty state, so it is dim too.
				lines.push({ text: padLine(descriptionPrefix, line), placeholder });
			});
		}

		return { itemIndex, lines };
	});
}

function flatten(blocks: ItemBlock[], selectedIndex: number): AnnotatedRow[] {
	return blocks.flatMap((block) =>
		block.lines.map((line) => ({
			line: line.text,
			selected: block.itemIndex === selectedIndex,
			placeholder: line.placeholder,
		})),
	);
}

export function renderSingleSelectRows({
	options,
	selectedIndex,
	width,
	maxRows,
	hideDescriptions,
	freeformDraft,
}: RenderSingleSelectRowsParams): AnnotatedRow[] {
	const itemCount = options.length + 1;
	const blocks = buildItemBlocks(options, width, selectedIndex, hideDescriptions, freeformDraft);
	const allRows = flatten(blocks, selectedIndex);

	if (!Number.isFinite(maxRows) || !maxRows || maxRows <= 0 || allRows.length <= maxRows) {
		return allRows;
	}

	const safeMaxRows = Math.max(1, Math.floor(maxRows));
	const selectedBlock = blocks[selectedIndex] ?? blocks[0];
	if (!selectedBlock) return [];

	const indicator = `  (${selectedIndex + 1}/${itemCount})`;
	const availableRows = safeMaxRows > 1 ? safeMaxRows - 1 : 1;

	if (selectedBlock.lines.length >= availableRows) {
		const visible = selectedBlock.lines.slice(0, availableRows).map((line) => ({
			line: line.text,
			selected: true,
			placeholder: line.placeholder,
		}));
		if (safeMaxRows > 1) visible.push({ line: indicator, selected: false, placeholder: false });
		return visible.slice(0, safeMaxRows);
	}

	let start = selectedIndex;
	let end = selectedIndex + 1;
	let usedRows = selectedBlock.lines.length;

	while (true) {
		const nextCanFit = end < blocks.length && usedRows + blocks[end]!.lines.length <= availableRows;
		if (nextCanFit) {
			usedRows += blocks[end]!.lines.length;
			end += 1;
			continue;
		}

		const prevCanFit = start > 0 && usedRows + blocks[start - 1]!.lines.length <= availableRows;
		if (prevCanFit) {
			start -= 1;
			usedRows += blocks[start]!.lines.length;
			continue;
		}

		break;
	}

	const visible = flatten(blocks.slice(start, end), selectedIndex);
	visible.push({ line: indicator, selected: false, placeholder: false });
	return visible.slice(0, safeMaxRows);
}
