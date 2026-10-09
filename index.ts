/**
 * Ask Tool Extension - Interactive question UI for pi-coding-agent
 *
 * Refactored to use built-in TUI primitives (Container/Text/Spacer/SelectList/Editor)
 * and a custom box border instead of manual ANSI box drawing.
 */

import type {
   AgentToolResult,
   AgentToolUpdateCallback,
   ExtensionAPI,
   ExtensionContext,
   ExtensionUIContext,
   Theme,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Type, type TUnsafe } from "@sinclair/typebox";
import {
   Container,
   type Component,
   CURSOR_MARKER,
   decodeKittyPrintable,
   Editor,
   type EditorTheme,
   fuzzyFilter,
   isKeyRelease,
   isKeyRepeat,
   Key,
   type Keybinding,
   type KeybindingsManager,
   Markdown,
   type MarkdownTheme,
   matchesKey,
   type OverlayHandle,
   type OverlayOptions,
   Spacer,
   Text,
   type TUI,
   truncateToWidth,
   visibleWidth,
   wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { renderSingleSelectRows, FREEFORM_HINT, FREEFORM_PLACEHOLDER, type QuestionOption } from "./single-select-layout";

import { createRequire } from "node:module";
import { join } from "node:path";
import {
   ASK_USER_DEFAULTS,
   ASK_USER_SETTING_KEYS,
   ASK_USER_SETTINGS_FILENAME,
   AskUserSettingsStore,
   isValidShortcutSpec,
   normalizeShortcutSpec,
   parseSettingValue,
   type AskUserConfig,
   type AskUserSettingKey,
} from "./ask-user-settings";
const _require = createRequire(import.meta.url);
const ASK_USER_VERSION: string = (_require("./package.json") as { version: string }).version;

/**
 * Emit a flat `{ type: "string", enum: [...] }` JSON Schema instead of the
 * `anyOf`/`oneOf` shape that `Type.Union([Type.Literal()])` produces. Google's
 * function-calling API rejects the union form. Local copy of pi-ai's StringEnum
 * to avoid a peer dependency for one helper.
 *
 * Some hosts (oh-my-pi) alias `@sinclair/typebox` to a shim whose `Type.Unsafe`
 * returns a plain object that `Type.Optional` cannot wrap (issue #38). On those
 * hosts a union of literals is a real runtime schema *and* already collapses to
 * the flat enum form, so we probe the builder and pick whichever path it
 * supports. `builder` is injectable for tests only.
 */
export type StringEnumBuilder = Pick<typeof Type, "Unsafe" | "Optional" | "Union" | "Literal">;

export function StringEnum<const T extends readonly string[]>(
   values: T,
   options?: { description?: string; default?: T[number] },
   builder: StringEnumBuilder = Type,
): TUnsafe<T[number]> {
   const meta = {
      ...(options?.description ? { description: options.description } : {}),
      ...(options?.default !== undefined ? { default: options.default } : {}),
   };
   try {
      builder.Optional(builder.Unsafe<string>({ type: "string" }));
      return builder.Unsafe<T[number]>({ type: "string", enum: [...values], ...meta });
   } catch {
      // fall through to the union path below
   }
   // Shim path: the union is a runtime schema, so `Type.Optional` works and the
   // enclosing `Type.Object` keeps every optional key optional. Chainable
   // `.describe()`/`.default()` are the shim's way to attach metadata; the
   // options argument covers builders that take it positionally instead.
   let schema = builder.Union(values.map((value) => builder.Literal(value)), meta) as unknown as {
      describe?: (text: string) => unknown;
      default?: (value: unknown) => unknown;
   };
   if (options?.description && typeof schema.describe === "function") {
      schema = schema.describe(options.description) as typeof schema;
   }
   if (options?.default !== undefined && typeof schema.default === "function") {
      schema = schema.default(options.default) as typeof schema;
   }
   return schema as unknown as TUnsafe<T[number]>;
}

/**
 * `getMarkdownTheme()` returns a bag of closures that read through a Proxy
 * over the host's theme singleton. The Proxy only throws on property access,
 * not when the bag itself is constructed — so a naive
 * `try { getMarkdownTheme() } catch {}` silently lets a broken bag escape
 * and crashes mid-render the first time pi-tui's Markdown calls
 * `mdTheme.bold(...)`.
 *
 * That broken-bag scenario shows up whenever this extension's bundled copy
 * of `@earendil-works/pi-coding-agent` is a different module instance than
 * the host's — e.g. an older Pi still on the legacy
 * `@mariozechner/pi-coding-agent` scope (≤ 0.73.1) where npm cannot dedupe
 * across scopes, so our copy's theme singleton is never initialised
 * (`globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")]` is
 * undefined). See https://github.com/edlsh/pi-ask-user/issues/17.
 *
 * Probe `bold("")` to force the Proxy lookup eagerly; on throw, callers
 * fall back to plain `Text` rendering for context blocks.
 */
function safeMarkdownTheme(): MarkdownTheme | undefined {
   try {
      const md = getMarkdownTheme();
      if (!md) return undefined;
      md.bold("");
      return md;
   } catch {
      return undefined;
   }
}

type AskDisplayMode = "overlay" | "inline";
type AskSingleSelectLayout = "auto" | "list";

/** One option as the model supplies it. `label` is the answer value. */
interface OptionInput {
   label: string;
   description: string;
   preview?: string;
}

interface BatchQuestionInput {
   question: string;
   header: string;
   options: OptionInput[];
   multiSelect?: boolean;
}

interface AskParams {
   questions: BatchQuestionInput[];
}

type AskAnswerKind = "option" | "custom" | "multi";

/**
 * One answer. `option` carries the chosen label in `answer`, `custom` the
 * free text the user typed, and `multi` `null` with the labels in `selected`.
 */
interface AskAnswer {
   question: string;
   kind: AskAnswerKind;
   answer: string | null;
   selected?: string[];
}

/** Answer without its question text, as it moves through the prompt UI. */
type AskUIResponse = Omit<AskAnswer, "question">;

/** Tool result details for every call. */
interface AskResultDetails {
   answers: AskAnswer[];
   cancelled: boolean;
   error?: string;
}

/** One validated entry of a `questions` batch. */
interface BatchQuestion {
   question: string;
   header: string;
   options: QuestionOption[];
   multiSelect: boolean;
}

const BATCH_MIN_QUESTIONS = 1;
const BATCH_MAX_QUESTIONS = 4;
const BATCH_MIN_OPTIONS = 2;
const BATCH_MAX_OPTIONS = 4;
/** Labels the prompt UI reserves for its own rows, so models may not use them. */
const RESERVED_OPTION_LABELS = ["Other", FREEFORM_PLACEHOLDER, "Next"] as const;
// Removed top-level fields: every question's data belongs inside questions.
const BATCH_ENTRY_FIELDS = ["question", "header", "options", "multiSelect"] as const;

type AskUIResult = AskUIResponse;

function coerceOption(option: unknown): QuestionOption | null {
   if (!option || typeof option !== "object") return null;
   const record = option as Record<string, unknown>;
   // Both label and description are required by the schema; a missing or
   // non-string value makes the whole option malformed.
   const label = typeof record.label === "string" ? record.label.trim() : "";
   if (!label) return null;
   if (typeof record.description !== "string") return null;
   const description = record.description;
   const preview = typeof record.preview === "string" && record.preview.trim() ? record.preview : undefined;
   return preview ? { label, description, preview } : { label, description };
}

function formatOptionsForMessage(options: QuestionOption[]): string {
   return options
      .map((option, index) => {
         const desc = option.description ? ` — ${option.description}` : "";
         return `${index + 1}. ${option.label}${desc}`;
      })
      .join("\n");
}

function createCustomResponse(text: string | null | undefined): AskUIResponse | null {
   const trimmed = text?.trim();
   return trimmed ? { kind: "custom", answer: trimmed } : null;
}

function createOptionResponse(label: string): AskUIResponse | null {
   const trimmed = label.trim();
   return trimmed ? { kind: "option", answer: trimmed } : null;
}

function createMultiResponse(labels: string[]): AskUIResponse | null {
   const selected = labels.map((label) => label.trim()).filter(Boolean);
   if (selected.length === 0) return null;
   return { kind: "multi", answer: null, selected };
}

function formatResponseSummary(response: AskUIResponse): string {
   if (response.kind === "multi") return response.selected?.join(", ") ?? "";
   return response.answer ?? "";
}

function parseDialogSelections(input: string): string[] {
   return input
      .split(",")
      .map((selection) => selection.trim())
      .filter(Boolean);
}

function isCancelledInput(value: unknown): value is null | undefined {
   return value === null || value === undefined;
}

function createSelectListTheme(theme: Theme) {
   return {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", t),
      description: (t: string) => theme.fg("muted", t),
      scrollInfo: (t: string) => theme.fg("dim", t),
      noMatch: (t: string) => theme.fg("warning", t),
   };
}

function createEditorTheme(theme: Theme): EditorTheme {
   return {
      borderColor: (s: string) => theme.fg("accent", s),
      selectList: createSelectListTheme(theme),
   };
}

const BOX_BORDER_LEFT = "│ ";
const BOX_BORDER_RIGHT = " │";
const BOX_BORDER_OVERHEAD = BOX_BORDER_LEFT.length + BOX_BORDER_RIGHT.length;
// Cells a framed box keeps around its title/label: `─ ` + label + ` ─`.
const TITLE_MIN_INNER = 4;

class BoxBorderTop implements Component {
   private color: (s: string) => string;
   private title?: string;
   private titleColor?: (s: string) => string;
   constructor(color: (s: string) => string, title?: string, titleColor?: (s: string) => string) {
      this.color = color;
      this.title = title;
      this.titleColor = titleColor;
   }
   invalidate(): void { }
   render(width: number): string[] {
      const inner = Math.max(0, width - 2);
      // Measure in rendered cells, not code units: a CJK or fullwidth title is
      // twice as wide as its length suggests, which would push the corner out
      // of the frame.
      // Too narrow for any label: plain border. A title that overflows is
      // truncated so it stays visible instead of disappearing.
      if (inner < TITLE_MIN_INNER) {
         return [this.color(`╭${"─".repeat(inner)}╮`)];
      }
      if (!this.title) {
         return [this.color(`╭${"─".repeat(inner)}╮`)];
      }
      const titleStyle = this.titleColor ?? this.color;
      if (inner < visibleWidth(this.title) + TITLE_MIN_INNER) {
         const clipped = truncateToWidth(this.title, inner - TITLE_MIN_INNER, "…");
         return [
            this.color("╭─") + titleStyle(` ${clipped} `) + this.color("─".repeat(Math.max(0, inner - 1 - visibleWidth(clipped) - 2)) + "╮"),
         ];
      }
      const label = ` ${this.title} `;
      const remaining = inner - 1 - visibleWidth(label);
      return [
         this.color("╭─") + titleStyle(label) + this.color("─".repeat(Math.max(0, remaining)) + "╮"),
      ];
   }
}

class BoxBorderBottom implements Component {
   private color: (s: string) => string;
   private label?: string;
   private labelColor?: (s: string) => string;
   constructor(color: (s: string) => string, label?: string, labelColor?: (s: string) => string) {
      this.color = color;
      this.label = label;
      this.labelColor = labelColor;
   }
   invalidate(): void { }
   render(width: number): string[] {
      const inner = Math.max(0, width - 2);
      if (!this.label || inner < visibleWidth(this.label) + 4) {
         return [this.color(`╰${"─".repeat(inner)}╯`)];
      }
      const tag = ` ${this.label} `;
      const leftDashes = inner - visibleWidth(tag) - 1;
      const style = this.labelColor ?? this.color;
      return [
         this.color("╰" + "─".repeat(Math.max(0, leftDashes))) + style(tag) + this.color("─╯"),
      ];
   }
}

function formatKeyList(keys: string[]): string {
   return keys.join("/");
}

function keybindingHint(
   theme: Theme,
   keybindings: KeybindingsManager,
   keybinding: Keybinding,
   description: string,
): string {
   return `${theme.fg("dim", formatKeyList(keybindings.getKeys(keybinding)))}${theme.fg("muted", ` ${description}`)}`;
}

function literalHint(theme: Theme, key: string, description: string): string {
   return `${theme.fg("dim", key)}${theme.fg("muted", ` ${description}`)}`;
}

type ResolvedShortcut =
   | { disabled: false; spec: string; matches: (data: string) => boolean }
   | { disabled: true; spec: null; matches: (data: string) => false };

interface ResolvedAskShortcuts {
   overlayToggle: ResolvedShortcut;
}

const DISABLED_SHORTCUT: ResolvedShortcut = {
   disabled: true,
   spec: null,
   matches: ((_data: string) => false) as (data: string) => false,
};

function buildShortcut(spec: string): ResolvedShortcut {
   return {
      disabled: false,
      spec,
      matches: (data: string) => matchesKey(data, spec as any),
   };
}

function resolveShortcut(
   configValue: string | null | undefined,
   envValue: string | undefined,
   defaultSpec: string,
): ResolvedShortcut {
   const candidates: Array<string | null | undefined> = [configValue, envValue, defaultSpec];
   for (const raw of candidates) {
      const normalized = normalizeShortcutSpec(raw);
      if (normalized === undefined) continue; // not provided, fall through
      if (normalized === null) return DISABLED_SHORTCUT; // explicit disable
      if (isValidShortcutSpec(normalized)) return buildShortcut(normalized);
      // Invalid spec: silently fall through to next candidate.
   }
   return DISABLED_SHORTCUT;
}

type AskMode = "select" | "freeform";

const ASK_OVERLAY_MAX_HEIGHT_RATIO = 0.85;
const ASK_OVERLAY_MIN_RENDER_LINES = 8;
const ASK_OVERLAY_WIDTH = "92%";
const ASK_OVERLAY_MIN_WIDTH = 40;
const SINGLE_SELECT_SPLIT_PANE_MIN_WIDTH = 84;
const SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH = 32;
const SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH = 28;
const SINGLE_SELECT_SPLIT_PANE_SEPARATOR = " │ ";
const FREEFORM_SENTINEL = "\u270f\ufe0f Type custom response...";
const DEFAULT_OVERLAY_TOGGLE_KEY = "alt+o";

// Vim-style aliases for navigating option lists. ctrl+j/k are safe in the
// searchable single-select because they don't collide with fuzzy-search input.
const VIM_SELECT_UP_KEY = Key.ctrl("k");
const VIM_SELECT_DOWN_KEY = Key.ctrl("j");
const PROMPT_SCROLL_PAGE_UP_KEY = Key.pageUp;
const PROMPT_SCROLL_PAGE_DOWN_KEY = Key.pageDown;
const PROMPT_SCROLL_HOME_KEY = Key.home;
const PROMPT_SCROLL_END_KEY = Key.end;
const PROMPT_SCROLL_HALF_PAGE_UP_KEY = Key.ctrl("u");
const PROMPT_SCROLL_HALF_PAGE_DOWN_KEY = Key.ctrl("d");

function getOverlayMaxRenderLinesForRows(rows: number): number {
   const normalizedRows = Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : 24;
   const availableRows = Math.max(1, normalizedRows - 2);
   const ratioRows = Math.max(1, Math.floor(normalizedRows * ASK_OVERLAY_MAX_HEIGHT_RATIO));
   const minimumRows = Math.min(ASK_OVERLAY_MIN_RENDER_LINES, availableRows);
   return Math.min(availableRows, Math.max(minimumRows, ratioRows));
}

function matchesSelectUp(data: string, keybindings: KeybindingsManager): boolean {
   return (
      keybindings.matches(data, "tui.select.up") ||
      matchesKey(data, Key.shift("tab")) ||
      matchesKey(data, VIM_SELECT_UP_KEY)
   );
}

function matchesSelectDown(data: string, keybindings: KeybindingsManager): boolean {
   return (
      keybindings.matches(data, "tui.select.down") ||
      matchesKey(data, Key.tab) ||
      matchesKey(data, VIM_SELECT_DOWN_KEY)
   );
}

function buildCustomUIOptions(
   displayMode: AskDisplayMode,
   onHandle?: (handle: OverlayHandle) => void,
): { overlay?: boolean; overlayOptions?: OverlayOptions; onHandle?: (handle: OverlayHandle) => void } | undefined {
   switch (displayMode) {
      case "inline":
         return undefined;
      case "overlay":
         return {
            overlay: true,
            overlayOptions: {
               anchor: "center" as const,
               width: ASK_OVERLAY_WIDTH,
               minWidth: ASK_OVERLAY_MIN_WIDTH,
               maxHeight: "85%",
               margin: 1,
            },
            ...(onHandle ? { onHandle } : {}),
         };
      default: {
         const _exhaustive: never = displayMode;
         void _exhaustive;
         return {
            overlay: true,
            overlayOptions: {
               anchor: "center" as const,
               width: ASK_OVERLAY_WIDTH,
               minWidth: ASK_OVERLAY_MIN_WIDTH,
               maxHeight: "85%",
               margin: 1,
            },
            ...(onHandle ? { onHandle } : {}),
         };
      }
   }
}

class MultiSelectList implements Component {
   private options: QuestionOption[];
   private theme: Theme;
   private keybindings: KeybindingsManager;
   private selectedIndex = 0;
   private checked = new Set<number>();
   private maxVisibleRows = 10;
   private cachedWidth?: number;
   private cachedLines?: string[];

   public onCancel?: () => void;
   public onSubmit?: (result: string[]) => void;
   public onEnterFreeform?: () => void;

   constructor(
      options: QuestionOption[],
      theme: Theme,
      keybindings: KeybindingsManager,
      private getFreeformDraft: () => string,
   ) {
      this.options = options;
      this.theme = theme;
      this.keybindings = keybindings;
   }

   setMaxVisibleRows(rows: number): void {
      const next = Math.max(1, Math.floor(rows));
      if (next !== this.maxVisibleRows) {
         this.maxVisibleRows = next;
         this.invalidate();
      }
   }

   invalidate(): void {
      this.cachedWidth = undefined;
      this.cachedLines = undefined;
   }

   private getItemCount(): number {
      return this.options.length + 1;
   }

   private getFreeformIndex(): number {
      return this.options.length;
   }

   private isFreeformRow(index: number): boolean {
      return index === this.getFreeformIndex();
   }

   private toggle(index: number): void {
      if (index < 0 || index >= this.options.length) return;
      if (this.checked.has(index)) this.checked.delete(index);
      else this.checked.add(index);
   }

   handleInput(data: string): void {
      if (this.keybindings.matches(data, "tui.select.cancel")) {
         this.onCancel?.();
         return;
      }

      const count = this.getItemCount();
      if (count === 0) {
         this.onCancel?.();
         return;
      }

      if (matchesSelectUp(data, this.keybindings)) {
         this.selectedIndex = this.selectedIndex === 0 ? count - 1 : this.selectedIndex - 1;
         this.invalidate();
         return;
      }

      if (matchesSelectDown(data, this.keybindings)) {
         this.selectedIndex = this.selectedIndex === count - 1 ? 0 : this.selectedIndex + 1;
         this.invalidate();
         return;
      }

      const numMatch = data.match(/^[1-9]$/);
      if (numMatch) {
         const idx = Number.parseInt(numMatch[0], 10) - 1;
         if (idx >= 0 && idx < this.options.length) {
            this.toggle(idx);
            this.selectedIndex = Math.min(idx, count - 1);
            this.invalidate();
         }
         return;
      }

      if (matchesKey(data, Key.space)) {
         if (this.isFreeformRow(this.selectedIndex)) {
            this.onEnterFreeform?.();
            return;
         }
         this.toggle(this.selectedIndex);
         this.invalidate();
         return;
      }

      if (this.keybindings.matches(data, "tui.select.confirm")) {
         if (this.isFreeformRow(this.selectedIndex)) {
            this.onEnterFreeform?.();
            return;
         }

         const selectedLabels = Array.from(this.checked)
            .sort((a, b) => a - b)
            .map((i) => this.options[i]?.label)
            .filter((t): t is string => !!t);

         const fallback = this.options[this.selectedIndex]?.label;
         const result = selectedLabels.length > 0 ? selectedLabels : fallback ? [fallback] : [];

         if (result.length > 0) this.onSubmit?.(result);
         else this.onCancel?.();
      }
   }

   render(width: number): string[] {
      if (this.cachedLines && this.cachedWidth === width) {
         return this.cachedLines;
      }

      const theme = this.theme;
      const count = this.getItemCount();

      if (count === 0) {
         this.cachedLines = [theme.fg("warning", "No options")];
         this.cachedWidth = width;
         return this.cachedLines;
      }

      const blocks: string[][] = [];

      for (let i = 0; i < count; i++) {
         const isSelected = i === this.selectedIndex;
         const prefix = isSelected ? theme.fg("accent", "→") : " ";
         const block: string[] = [];

         if (this.isFreeformRow(i)) {
            // The free-form row is numbered like the options. While it holds no
            // draft it shows a dim placeholder and hint, like an empty input
            // field; once the user has typed something the row shows that text.
            // The blank checkbox slot keeps its text aligned with option titles.
            const draft = this.getFreeformDraft().trim();
            const num = theme.fg("dim", `${i + 1}.`);
            const title = draft || FREEFORM_PLACEHOLDER;
            const styledTitle = isSelected
               ? theme.fg("accent", theme.bold(title))
               : draft
                  ? theme.fg("text", theme.bold(title))
                  : theme.fg("dim", title);
            block.push(truncateToWidth(`${prefix} ${num}     ${styledTitle}`, width, ""));
            if (!draft) {
               const indent = "      ";
               const wrapWidth = Math.max(10, width - indent.length);
               for (const wrapped of wrapTextWithAnsi(FREEFORM_HINT, wrapWidth)) {
                  block.push(truncateToWidth(indent + theme.fg("dim", wrapped), width, ""));
               }
            }
            blocks.push(block);
            continue;
         }

         const option = this.options[i]!;

         const checkbox = this.checked.has(i) ? theme.fg("success", "[✓]") : theme.fg("dim", "[ ]");
         const num = theme.fg("dim", `${i + 1}.`);
         const title = isSelected
            ? theme.fg("accent", theme.bold(option.label))
            : theme.fg("text", theme.bold(option.label));

         const firstLine = `${prefix} ${num} ${checkbox} ${title}`;
         block.push(truncateToWidth(firstLine, width, ""));

         if (option.description) {
            const indent = "      ";
            const wrapWidth = Math.max(10, width - indent.length);
            const wrapped = wrapTextWithAnsi(option.description, wrapWidth);
            for (const w of wrapped) {
               block.push(truncateToWidth(indent + theme.fg("muted", w), width, ""));
            }
         }

         blocks.push(block);
      }

      const maxRows = this.maxVisibleRows;
      const totalRows = blocks.reduce((sum, block) => sum + block.length, 0);
      let lines: string[];

      if (totalRows <= maxRows) {
         lines = blocks.flat();
      } else {
         const availableRows = maxRows > 1 ? maxRows - 1 : 1;
         const selectedBlock = blocks[this.selectedIndex] ?? blocks[0] ?? [];

         if (selectedBlock.length >= availableRows) {
            lines = selectedBlock.slice(0, availableRows);
         } else {
            let startIndex = this.selectedIndex;
            let endIndex = this.selectedIndex + 1;
            let usedRows = selectedBlock.length;

            while (true) {
               const nextBlock = blocks[endIndex];
               if (nextBlock && usedRows + nextBlock.length <= availableRows) {
                  usedRows += nextBlock.length;
                  endIndex += 1;
                  continue;
               }

               const previousBlock = blocks[startIndex - 1];
               if (previousBlock && usedRows + previousBlock.length <= availableRows) {
                  startIndex -= 1;
                  usedRows += previousBlock.length;
                  continue;
               }

               break;
            }

            lines = blocks.slice(startIndex, endIndex).flat();
         }

         if (maxRows > 1) {
            lines.push(theme.fg("dim", truncateToWidth(`  (${this.selectedIndex + 1}/${count})`, width, "")));
         }
      }

      this.cachedWidth = width;
      this.cachedLines = lines;
      return lines;
   }
}

class WrappedSingleSelectList implements Component {
   private options: QuestionOption[];
   private theme: Theme;
   private singleSelectLayout: AskSingleSelectLayout;
   private keybindings: KeybindingsManager;
   private selectedIndex = 0;
   private searchQuery = "";
   private maxVisibleRows = 12;
   private cachedWidth?: number;
   private cachedLines?: string[];

   public onCancel?: () => void;
   public onSubmit?: (result: string) => void;
   public onEnterFreeform?: () => void;

   constructor(
      options: QuestionOption[],
      theme: Theme,
      singleSelectLayout: AskSingleSelectLayout,
      keybindings: KeybindingsManager,
      private getFreeformDraft: () => string,
   ) {
      this.options = options;
      this.theme = theme;
      this.singleSelectLayout = singleSelectLayout;
      this.keybindings = keybindings;
   }

   setMaxVisibleRows(rows: number): void {
      const next = Math.max(1, Math.floor(rows));
      if (next !== this.maxVisibleRows) {
         this.maxVisibleRows = next;
         this.invalidate();
      }
   }

   invalidate(): void {
      this.cachedWidth = undefined;
      this.cachedLines = undefined;
   }

   private getFilteredOptions(): QuestionOption[] {
      return fuzzyFilter(this.options, this.searchQuery, (option) => `${option.label} ${option.description ?? ""}`);
   }

   private getItemCount(filteredOptions: QuestionOption[]): number {
      return filteredOptions.length + 1;
   }

   private isFreeformRow(index: number, filteredOptions: QuestionOption[]): boolean {
      return index === filteredOptions.length;
   }

   private setSearchQuery(query: string): void {
      this.searchQuery = query;
      this.selectedIndex = 0;
      this.invalidate();
   }

   private popSearchCharacter(): void {
      if (!this.searchQuery) return;
      const characters = [...this.searchQuery];
      characters.pop();
      this.setSearchQuery(characters.join(""));
   }

   private getPrintableInput(data: string): string | null {
      const kittyPrintable = decodeKittyPrintable(data);
      if (kittyPrintable !== undefined) return kittyPrintable;

      const characters = [...data];
      if (characters.length !== 1) return null;

      const [character] = characters;
      if (!character) return null;

      const code = character.charCodeAt(0);
      if (code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
         return null;
      }

      return character;
   }

   private styleListLine(line: string, width: number, isSelected: boolean, placeholder = false): string {
      const trimmed = line.trim();

      if (trimmed.startsWith("(")) {
         return truncateToWidth(this.theme.fg("dim", line), width, "");
      }

      // An empty free-form row keeps its number and pointer in the usual
      // colours but dims the placeholder text and its hint, like an empty
      // input field waiting for the user.
      if (placeholder) {
         const numbered = line.match(/^([→ ] \d+\. )/);
         if (numbered) {
            const prefix = numbered[1]!;
            const styledPrefix = isSelected
               ? this.theme.fg("accent", this.theme.bold(prefix))
               : this.theme.fg("text", prefix);
            return truncateToWidth(styledPrefix + this.theme.fg("dim", line.slice(prefix.length)), width, "");
         }
         return truncateToWidth(this.theme.fg("dim", line), width, "");
      }

      if (isSelected) {
         return truncateToWidth(this.theme.fg("accent", this.theme.bold(line)), width, "");
      }

      if (line.startsWith("      ")) {
         return truncateToWidth(this.theme.fg("muted", line), width, "");
      }

      if (line.startsWith("→")) {
         return truncateToWidth(this.theme.fg("accent", this.theme.bold(line)), width, "");
      }

      return truncateToWidth(this.theme.fg("text", line), width, "");
   }

   private getSplitPaneWidths(width: number): { left: number; right: number } | null {
      if (this.singleSelectLayout === "list") return null;
      if (width < SINGLE_SELECT_SPLIT_PANE_MIN_WIDTH) return null;

      const availableWidth = width - SINGLE_SELECT_SPLIT_PANE_SEPARATOR.length;
      if (availableWidth < SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH + SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH) {
         return null;
      }

      const preferredLeftWidth = Math.floor(availableWidth * 0.42);
      const left = Math.max(
         SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH,
         Math.min(preferredLeftWidth, availableWidth - SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH),
      );
      const right = availableWidth - left;

      if (right < SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH) return null;
      return { left, right };
   }

   private buildListLines(width: number, filteredOptions: QuestionOption[], hideDescriptions = false): string[] {
      const lines: string[] = [];
      const count = this.getItemCount(filteredOptions);
      const searchValue = this.searchQuery ? this.theme.fg("text", this.searchQuery) : this.theme.fg("dim", "type to filter");
      lines.push(truncateToWidth(`${this.theme.fg("accent", "Filter:")} ${searchValue}`, width, ""));

      if (this.searchQuery && filteredOptions.length === 0) {
         lines.push(truncateToWidth(this.theme.fg("warning", "No matching options"), width, ""));
      }

      if (count === 0) {
         if (!this.searchQuery) {
            lines.push(truncateToWidth(this.theme.fg("warning", "No options"), width, ""));
         }
         return lines.slice(0, this.maxVisibleRows);
      }

      const maxRows = Math.max(1, this.maxVisibleRows - lines.length);
      const optionRows = renderSingleSelectRows({
         options: filteredOptions,
         selectedIndex: this.selectedIndex,
         width,
         maxRows,
         hideDescriptions,
         freeformDraft: this.getFreeformDraft(),
      });
      const optionLines = optionRows.map((row) => this.styleListLine(row.line, width, row.selected, row.placeholder));

      lines.push(...optionLines);
      return lines.slice(0, this.maxVisibleRows);
   }

   private buildPreviewLines(width: number, filteredOptions: QuestionOption[], maxLines: number): string[] {
      if (maxLines <= 0) return [];

      const mdTheme = safeMarkdownTheme();

      let md = "";

      if (this.isFreeformRow(this.selectedIndex, filteredOptions)) {
         md += "## Custom response\n\n";
         md += "Open the editor to write **any** answer.\n\n";
         md += "*Use this when none of the listed options fit.*\n";
         if (this.searchQuery) {
            md += `\n> Current filter: \`${this.searchQuery}\`\n`;
         }
      } else {
         const selected = filteredOptions[this.selectedIndex];
         if (!selected) {
            md += "*No option selected*\n";
         } else {
            md += `## ${selected.label}\n\n`;
            const detail = selected.preview?.trim() || selected.description?.trim();
            if (detail) {
               md += `${detail}\n`;
            } else {
               md += "*No additional details provided for this option.*\n";
            }
            md += `\n---\n\nPress \`Enter\` to select this option.\n`;
            if (this.searchQuery) {
               md += `\n> Filter: \`${this.searchQuery}\`\n`;
            }
         }
      }

      let lines: string[];
      if (mdTheme) {
         const mdComponent = new Markdown(md.trim(), 0, 0, mdTheme);
         lines = mdComponent.render(width);
      } else {
         lines = [];
         for (const line of wrapTextWithAnsi(md.trim(), Math.max(10, width))) {
            lines.push(truncateToWidth(line, width, ""));
         }
      }

      while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
         lines.pop();
      }

      if (lines.length <= maxLines) return lines;
      if (maxLines === 1) return [truncateToWidth(this.theme.fg("dim", "…"), width, "")];

      const visibleLines = lines.slice(0, maxLines - 1);
      visibleLines.push(truncateToWidth(this.theme.fg("dim", "…"), width, ""));
      return visibleLines;
   }

   handleInput(data: string): void {
      if (this.searchQuery && matchesKey(data, Key.escape)) {
         this.setSearchQuery("");
         return;
      }

      if (this.keybindings.matches(data, "tui.select.cancel")) {
         this.onCancel?.();
         return;
      }

      const filteredOptions = this.getFilteredOptions();
      const count = this.getItemCount(filteredOptions);

      if (matchesSelectUp(data, this.keybindings) && count > 0) {
         this.selectedIndex = this.selectedIndex === 0 ? count - 1 : this.selectedIndex - 1;
         this.invalidate();
         return;
      }

      if (matchesSelectDown(data, this.keybindings) && count > 0) {
         this.selectedIndex = this.selectedIndex === count - 1 ? 0 : this.selectedIndex + 1;
         this.invalidate();
         return;
      }

      const numMatch = data.match(/^[1-9]$/);
      if (numMatch && filteredOptions.length > 0) {
         const idx = Number.parseInt(numMatch[0], 10) - 1;
         if (idx >= 0 && idx < filteredOptions.length) {
            this.selectedIndex = idx;
            this.invalidate();
            return;
         }
      }

      if (this.keybindings.matches(data, "tui.select.confirm") && count > 0) {
         if (this.isFreeformRow(this.selectedIndex, filteredOptions)) {
            this.onEnterFreeform?.();
            return;
         }

         const result = filteredOptions[this.selectedIndex]?.label;
         if (result) this.onSubmit?.(result);
         else this.onCancel?.();
         return;
      }

      if (this.keybindings.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, Key.backspace)) {
         this.popSearchCharacter();
         return;
      }

      const printableInput = this.getPrintableInput(data);
      if (printableInput) {
         this.setSearchQuery(this.searchQuery + printableInput);
      }
   }

   render(width: number): string[] {
      if (this.cachedLines && this.cachedWidth === width) {
         return this.cachedLines;
      }

      const filteredOptions = this.getFilteredOptions();
      const count = this.getItemCount(filteredOptions);
      this.selectedIndex = count > 0 ? Math.max(0, Math.min(this.selectedIndex, count - 1)) : 0;

      const splitPane = this.getSplitPaneWidths(width);
      let lines: string[];

      if (!splitPane) {
         lines = this.buildListLines(width, filteredOptions);
      } else {
         const listLines = this.buildListLines(splitPane.left, filteredOptions, true);
         const previewLines = this.buildPreviewLines(splitPane.right, filteredOptions, this.maxVisibleRows);
         const rowCount = Math.min(this.maxVisibleRows, Math.max(listLines.length, previewLines.length));
         const separator = this.theme.fg("dim", SINGLE_SELECT_SPLIT_PANE_SEPARATOR);
         lines = Array.from({ length: rowCount }, (_, index) => {
            const left = truncateToWidth(listLines[index] ?? "", splitPane.left, "", true);
            const right = truncateToWidth(previewLines[index] ?? "", splitPane.right, "");
            return `${left}${separator}${right}`;
         });
      }

      this.cachedWidth = width;
      this.cachedLines = lines;
      return lines;
   }
}

/**
 * Interactive ask UI. Uses a root Container for layout and swaps the center
 * component between SelectList/MultiSelectList and an Editor (freeform mode).
 */
class AskComponent extends Container {
   private question: string;
   private options: QuestionOption[];
   private multiSelect: boolean;
   private displayMode: AskDisplayMode;
   private singleSelectLayout: AskSingleSelectLayout;
   private tui: TUI;
   private theme: Theme;
   private keybindings: KeybindingsManager;
   private shortcuts: ResolvedAskShortcuts;
   private onDone: (result: AskUIResult | null) => void;

   private mode: AskMode = "select";
   private freeformDraft = "";
   private promptScrollOffset = 0;
   private promptMaxScrollOffset = 0;
   private promptViewportRows = 0;
   // The frame title is this question's header; a batch page replaces it with
   // its own progress strip via setBatchChrome.
   private frameTitle: string;
   private navigationHint: string | null = null;

   // Static layout components
   private questionText: Text;
   private modeContainer: Container;
   private helpText: Text;

   // Mode components
   private singleSelectList?: WrappedSingleSelectList;
   private multiSelectList?: MultiSelectList;
   private editor?: Editor;

   // Focusable - propagate to Editor for IME cursor positioning
   private _focused = false;
   get focused(): boolean {
      return this._focused;
   }
   set focused(value: boolean) {
      this._focused = value;
      if (this.editor && this.mode === "freeform") {
         (this.editor as any).focused = value;
      }
   }

   constructor(
      question: string,
      header: string,
      options: QuestionOption[],
      multiSelect: boolean,
      displayMode: AskDisplayMode,
      singleSelectLayout: AskSingleSelectLayout,
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      shortcuts: ResolvedAskShortcuts,
      onDone: (result: AskUIResult | null) => void,
   ) {
      super();

      this.question = question;
      this.frameTitle = header;
      this.options = options;
      this.multiSelect = multiSelect;
      this.displayMode = displayMode;
      this.singleSelectLayout = singleSelectLayout;
      this.tui = tui;
      this.theme = theme;
      this.keybindings = keybindings;
      this.shortcuts = shortcuts;
      this.onDone = onDone;

      // Layout skeleton
      this.addChild(new BoxBorderTop(
         (s: string) => theme.fg("accent", s),
         "ask_user_question",
         (s: string) => theme.fg("dim", theme.bold(s)),
      ));
      this.addChild(new Spacer(1));

      this.questionText = new Text("", 1, 0);
      this.addChild(this.questionText);

      this.addChild(new Spacer(1));

      this.modeContainer = new Container();
      this.addChild(this.modeContainer);

      this.addChild(new Spacer(1));
      this.helpText = new Text("", 1, 0);
      this.addChild(this.helpText);

      this.addChild(new Spacer(1));
      this.addChild(new BoxBorderBottom(
         (s: string) => theme.fg("accent", s),
         `v${ASK_USER_VERSION}`,
         (s: string) => theme.fg("dim", s),
      ));

      this.updateStaticText();
      this.showSelectMode();
   }

   override invalidate(): void {
      super.invalidate();
      this.updateStaticText();
      this.updateHelpText();
   }

   override render(width: number): string[] {
      const innerWidth = Math.max(1, width - BOX_BORDER_OVERHEAD);

      if (this.displayMode === "overlay") {
         return this.renderOverlayLayout(width, innerWidth);
      }

      if (this.mode === "select" && !this.multiSelect) {
         this.ensureSingleSelectList().setMaxVisibleRows(12);
      }

      return this.renderInlineLayout(width, innerWidth);
   }

   private renderInlineLayout(width: number, innerWidth: number): string[] {
      const bodyLines = [
         ...this.buildPromptLines(innerWidth),
         "",
         ...this.modeContainer.render(innerWidth),
         "",
         ...this.helpText.render(innerWidth),
      ];
      return this.frameBodyLines(bodyLines, width, innerWidth);
   }

   private getOverlayMaxRenderLines(): number {
      const rows = Number.isFinite(this.tui.terminal.rows) ? Math.floor(this.tui.terminal.rows) : 24;
      return getOverlayMaxRenderLinesForRows(rows);
   }

   private renderOverlayLayout(width: number, innerWidth: number): string[] {
      const maxLines = this.getOverlayMaxRenderLines();
      if (maxLines <= 1) return [this.renderTopBorder(width)];
      if (maxLines === 2) return [this.renderTopBorder(width), this.renderBottomBorder(width)];

      const bodyCapacity = Math.max(0, maxLines - 2);
      const helpFullLines = this.helpText.render(innerWidth);
      const promptLines = this.buildPromptLines(innerWidth);
      const helpBudget = this.getOverlayHelpBudget(bodyCapacity, helpFullLines.length);
      const contentRows = Math.max(0, bodyCapacity - helpBudget);

      let promptBudget = 0;
      let modeBudget = 0;
      let separatorRows = 0;

      if (this.mode === "select") {
         separatorRows = contentRows >= 4 ? 1 : 0;
         const promptAndModeRows = Math.max(0, contentRows - separatorRows);
         promptBudget = promptAndModeRows;

         if (promptAndModeRows > 0) {
            const promptMinRows = promptLines.length > 0 ? 1 : 0;
            const maximumModeRows = Math.max(0, promptAndModeRows - promptMinRows);
            const modeMinRows = Math.min(this.getMinimumModeRows(), maximumModeRows);
            modeBudget = Math.min(this.getPreferredModeRows(), maximumModeRows);
            modeBudget = Math.max(modeMinRows, modeBudget);
            promptBudget = promptAndModeRows - modeBudget;

            const usefulPromptTarget = 2;
            const usefulPromptRows = Math.min(
               promptLines.length,
               promptAndModeRows >= modeMinRows + usefulPromptTarget ? usefulPromptTarget : promptMinRows,
            );
            if (promptBudget < usefulPromptRows && modeBudget > modeMinRows) {
               const shiftedRows = Math.min(usefulPromptRows - promptBudget, modeBudget - modeMinRows);
               modeBudget -= shiftedRows;
               promptBudget += shiftedRows;
            }
         }
      } else {
         modeBudget = Math.min(this.getPreferredModeRows(), contentRows);
         modeBudget = Math.max(Math.min(this.getMinimumModeRows(), contentRows), modeBudget);
         promptBudget = Math.max(0, contentRows - modeBudget);
         if (promptBudget > 0 && modeBudget > 0) {
            separatorRows = 1;
            promptBudget = Math.max(0, promptBudget - separatorRows);
         }
      }

      const modeLines = this.renderModeLines(innerWidth, modeBudget);
      if (modeLines.length < modeBudget) {
         promptBudget += modeBudget - modeLines.length;
      }

      const promptPaneLines = this.renderPromptPane(promptLines, promptBudget, innerWidth);
      const helpLines = this.limitLines(helpFullLines, helpBudget, innerWidth, false);
      const bodyLines = [
         ...promptPaneLines,
         ...(separatorRows > 0 && promptPaneLines.length > 0 && modeLines.length > 0 ? [""] : []),
         ...modeLines,
         ...helpLines,
      ];

      return this.frameBodyLines(bodyLines.slice(0, bodyCapacity), width, innerWidth);
   }

   private buildQuestionLines(width: number): string[] {
      return this.questionText.render(width);
   }

   private buildPromptLines(width: number): string[] {
      return this.buildQuestionLines(width);
   }

   private getOverlayHelpBudget(bodyCapacity: number, renderedHelpRows: number): number {
      if (renderedHelpRows <= 0 || bodyCapacity <= 0) return 0;
      if (bodyCapacity >= 12) return Math.min(2, renderedHelpRows);
      return 1;
   }

   private getMinimumModeRows(): number {
      if (this.mode === "freeform") return 5;
      return 3;
   }

   private getPreferredModeRows(): number {
      if (this.mode === "freeform") return 10;
      return 8;
   }

   private renderModeLines(width: number, budget: number): string[] {
      const safeBudget = Math.max(0, Math.floor(budget));
      if (safeBudget <= 0) return [];

      if (this.mode === "select") {
         if (this.multiSelect) {
            this.ensureMultiSelectList().setMaxVisibleRows(Math.max(1, safeBudget));
         } else {
            this.ensureSingleSelectList().setMaxVisibleRows(Math.max(1, safeBudget));
         }
         return this.limitLines(this.modeContainer.render(width), safeBudget, width, true);
      }

      return this.renderEditorModeLines(width, safeBudget);
   }

   private renderEditorModeLines(width: number, budget: number): string[] {
      const headerLines = this.buildEditorModeHeaderLines(width);
      const minimumEditorRows = Math.min(3, budget);
      const headerBudget = Math.max(0, budget - minimumEditorRows);
      const visibleHeaderLines = this.limitLines(headerLines, headerBudget, width, true);
      const editorBudget = Math.max(0, budget - visibleHeaderLines.length);

      return [
         ...visibleHeaderLines,
         ...this.limitEditorLines(this.ensureEditor().render(width), editorBudget, width),
      ];
   }

   private buildEditorModeHeaderLines(width: number): string[] {
      return [
         ...new Text(this.theme.fg("accent", this.theme.bold("Custom response")), 1, 0).render(width),
         "",
      ];
   }

   private limitEditorLines(lines: string[], budget: number, width: number): string[] {
      const safeBudget = Math.max(0, Math.floor(budget));
      if (safeBudget <= 0) return [];
      if (lines.length <= safeBudget) {
         return lines.map((line) => truncateToWidth(line, width, "", true));
      }
      if (safeBudget === 1) return [this.theme.fg("dim", "…")];

      const topBorder = truncateToWidth(lines[0] ?? "", width, "", true);
      const bottomBorder = truncateToWidth(lines[lines.length - 1] ?? "", width, "", true);
      if (safeBudget === 2) return [topBorder, bottomBorder];

      const contentLines = lines.slice(1, -1);
      const contentBudget = safeBudget - 2;
      // Locate the cursor row: prefer the zero-width CURSOR_MARKER the editor
      // emits while focused (the same mechanism pi-tui core uses for hardware
      // cursor placement), falling back to the inverse-video fake cursor.
      const cursorLineIndex = contentLines.findIndex(
         (line) => line.includes(CURSOR_MARKER) || line.includes("\x1b[7m"),
      );
      const maxStart = Math.max(0, contentLines.length - contentBudget);
      const start = cursorLineIndex >= 0
         ? Math.max(0, Math.min(cursorLineIndex - contentBudget + 1, maxStart))
         : maxStart;
      const visibleContentLines = contentLines.slice(start, start + contentBudget);
      const markedContentLines = this.applyPromptOverflowMarkers(
         visibleContentLines,
         width,
         start > 0,
         start + contentBudget < contentLines.length,
      );

      return [topBorder, ...markedContentLines, bottomBorder];
   }

   private renderPromptPane(promptLines: string[], budget: number, width: number): string[] {
      const viewportRows = Math.max(0, Math.floor(budget));
      this.promptViewportRows = viewportRows;

      if (viewportRows <= 0 || promptLines.length === 0) {
         this.promptMaxScrollOffset = 0;
         this.promptScrollOffset = 0;
         return [];
      }

      this.promptMaxScrollOffset = Math.max(0, promptLines.length - viewportRows);
      this.promptScrollOffset = Math.max(0, Math.min(this.promptScrollOffset, this.promptMaxScrollOffset));

      const visibleLines = promptLines.slice(this.promptScrollOffset, this.promptScrollOffset + viewportRows);
      const hasHiddenAbove = this.promptScrollOffset > 0;
      const hasHiddenBelow = this.promptScrollOffset + viewportRows < promptLines.length;
      return this.applyPromptOverflowMarkers(visibleLines, width, hasHiddenAbove, hasHiddenBelow);
   }

   private applyPromptOverflowMarkers(
      lines: string[],
      width: number,
      hasHiddenAbove: boolean,
      hasHiddenBelow: boolean,
   ): string[] {
      if (lines.length === 0) return lines;

      const marked = [...lines];
      if (hasHiddenAbove && hasHiddenBelow && marked.length === 1) {
         marked[0] = this.addPromptOverflowMarker(marked[0] ?? "", "↕", width);
         return marked;
      }

      if (hasHiddenAbove) {
         marked[0] = this.addPromptOverflowMarker(marked[0] ?? "", "↑", width);
      }
      if (hasHiddenBelow) {
         const lastIndex = marked.length - 1;
         marked[lastIndex] = this.addPromptOverflowMarker(marked[lastIndex] ?? "", "↓", width);
      }
      return marked;
   }

   private addPromptOverflowMarker(line: string, marker: string, width: number): string {
      return truncateToWidth(`${this.theme.fg("dim", marker)} ${line}`, width, "", true);
   }

   private limitLines(lines: string[], budget: number, width: number, showOverflowMarker: boolean): string[] {
      const safeBudget = Math.max(0, Math.floor(budget));
      if (safeBudget <= 0) return [];
      if (lines.length <= safeBudget) {
         return lines.map((line) => truncateToWidth(line, width, "", true));
      }
      if (!showOverflowMarker) {
         return lines.slice(0, safeBudget).map((line) => truncateToWidth(line, width, "", true));
      }
      if (safeBudget === 1) return [this.theme.fg("dim", "…")];
      return [
         ...lines.slice(0, safeBudget - 1).map((line) => truncateToWidth(line, width, "", true)),
         this.theme.fg("dim", "…"),
      ];
   }

   private renderTopBorder(width: number): string {
      return new BoxBorderTop(
         (s: string) => this.theme.fg("accent", s),
         this.frameTitle,
         (s: string) => this.theme.fg("dim", this.theme.bold(s)),
      ).render(width)[0] ?? "";
   }

   private renderBottomBorder(width: number): string {
      return new BoxBorderBottom(
         (s: string) => this.theme.fg("accent", s),
         `v${ASK_USER_VERSION}`,
         (s: string) => this.theme.fg("dim", s),
      ).render(width)[0] ?? "";
   }

   private frameBodyLines(bodyLines: string[], width: number, innerWidth: number): string[] {
      const borderColor = (s: string) => this.theme.fg("accent", s);
      return [
         this.renderTopBorder(width),
         ...bodyLines.map((line) => {
            const padded = truncateToWidth(line, innerWidth, "", true);
            return `${borderColor(BOX_BORDER_LEFT)}${padded}${borderColor(BOX_BORDER_RIGHT)}`;
         }),
         this.renderBottomBorder(width),
      ];
   }

   private updateStaticText(): void {
      const theme = this.theme;
      this.questionText.setText(theme.fg("text", theme.bold(this.question)));
   }

   private updateHelpText(): void {
      const theme = this.theme;
      const overlayHint = this.displayMode === "overlay" && !this.shortcuts.overlayToggle.disabled
         ? literalHint(theme, this.shortcuts.overlayToggle.spec, "hide")
         : null;
      const promptScrollHint = this.displayMode === "overlay"
         ? literalHint(theme, "PgUp/PgDn", "prompt")
         : null;
      if (this.mode === "freeform") {
         const alternateCancelKeys = this.keybindings
            .getKeys("tui.select.cancel")
            .filter((key) => key !== "escape" && key !== "esc");
         const hints = [
            this.navigationHint,
            keybindingHint(theme, this.keybindings, "tui.input.submit", "submit"),
            keybindingHint(theme, this.keybindings, "tui.input.newLine", "newline"),
            literalHint(theme, "esc", "back"),
            overlayHint,
            alternateCancelKeys.length > 0 ? literalHint(theme, formatKeyList(alternateCancelKeys), "cancel") : null,
         ]
            .filter((hint): hint is string => !!hint)
            .join(" • ");
         this.helpText.setText(theme.fg("dim", hints));
         return;
      }

      if (this.multiSelect) {
         const hints = [
            this.navigationHint,
            literalHint(theme, "↑↓", "navigate"),
            literalHint(theme, "space", "toggle"),
            promptScrollHint,
            overlayHint,
            keybindingHint(theme, this.keybindings, "tui.select.confirm", "submit"),
            keybindingHint(theme, this.keybindings, "tui.select.cancel", "cancel"),
         ]
            .filter((hint): hint is string => !!hint)
            .join(" • ");
         this.helpText.setText(theme.fg("dim", hints));
      } else {
         const alternateCancelKeys = this.keybindings
            .getKeys("tui.select.cancel")
            .filter((key) => key !== "escape" && key !== "esc");
         const hints = [
            this.navigationHint,
            literalHint(theme, "type", "filter"),
            promptScrollHint,
            keybindingHint(theme, this.keybindings, "tui.editor.deleteCharBackward", "erase"),
            literalHint(theme, "↑↓", "navigate"),
            overlayHint,
            keybindingHint(theme, this.keybindings, "tui.select.confirm", "select"),
            literalHint(theme, "esc", "clear/cancel"),
            alternateCancelKeys.length > 0
               ? literalHint(theme, formatKeyList(alternateCancelKeys), "cancel")
               : null,
         ]
            .filter((hint): hint is string => !!hint)
            .join(" • ");
         this.helpText.setText(theme.fg("dim", hints));
      }
   }

   /** Batch pages: show the question strip in the frame title and the page-navigation hint. */
   setBatchChrome(frameTitle: string, navigationHint: string): void {
      this.frameTitle = frameTitle;
      this.navigationHint = navigationHint;
      this.updateHelpText();
   }

   /**
    * Leaving a batch page. A page left while its free-form editor is open keeps
    * the typed text as a draft and returns to the option list, so coming back
    * shows the draft on the numbered free-form row instead of the editor.
    */
   leavePage(): void {
      if (this.mode === "freeform") {
         this.showSelectMode();
      }
   }

   private ensureSingleSelectList(): WrappedSingleSelectList {
      if (this.singleSelectList) return this.singleSelectList;

      const list = new WrappedSingleSelectList(
         this.options,
         this.theme,
         this.singleSelectLayout,
         this.keybindings,
         () => this.freeformDraft,
      );
      list.onSubmit = (result) => this.handleOptionSubmit(result);
      list.onCancel = () => this.onDone(null);
      list.onEnterFreeform = () => this.showFreeformMode();

      this.singleSelectList = list;
      return list;
   }

   private ensureMultiSelectList(): MultiSelectList {
      if (this.multiSelectList) return this.multiSelectList;

      const list = new MultiSelectList(
         this.options,
         this.theme,
         this.keybindings,
         () => this.freeformDraft,
      );
      list.onCancel = () => this.onDone(null);
      list.onSubmit = (result) => this.handleMultiSubmit(result);
      list.onEnterFreeform = () => this.showFreeformMode();

      this.multiSelectList = list;
      return list;
   }

   private ensureEditor(): Editor {
      if (this.editor) return this.editor;
      const editor = new Editor(this.tui, createEditorTheme(this.theme));
      editor.disableSubmit = false;
      editor.onSubmit = (text: string) => {
         this.handleEditorSubmit(text);
      };
      this.editor = editor;
      return editor;
   }

   private saveEditorDraft(): void {
      if (!this.editor) return;
      const getText = (this.editor as any).getText;
      if (typeof getText !== "function") return;

      const currentText = String(getText.call(this.editor) ?? "");
      if (this.mode === "freeform") {
         this.freeformDraft = currentText;
         // The numbered free-form row shows the draft once one exists, so both
         // lists must drop their cached rows when the draft changes.
         this.singleSelectList?.invalidate();
         this.multiSelectList?.invalidate();
      }
   }

   private setEditorText(text: string): void {
      const editor = this.ensureEditor();
      const setText = (editor as any).setText;
      if (typeof setText === "function") {
         setText.call(editor, text);
      }
   }

   private handleOptionSubmit(label: string): void {
      this.onDone(createOptionResponse(label));
   }

   private handleMultiSubmit(labels: string[]): void {
      this.onDone(createMultiResponse(labels));
   }

   private handleEditorSubmit(text: string): void {
      if (this.mode === "freeform") {
         this.onDone(createCustomResponse(text));
      }
   }

   private showSelectMode(): void {
      if (this.mode === "freeform") {
         this.saveEditorDraft();
      }

      this.mode = "select";
      this.modeContainer.clear();

      if (this.multiSelect) {
         this.modeContainer.addChild(this.ensureMultiSelectList());
      } else {
         this.modeContainer.addChild(this.ensureSingleSelectList());
      }

      this.updateHelpText();
      this.invalidate();
      this.tui.requestRender();
   }

   private showFreeformMode(): void {
      this.mode = "freeform";
      this.modeContainer.clear();

      const editor = this.ensureEditor();
      this.setEditorText(this.freeformDraft);
      (editor as any).focused = this._focused;

      this.modeContainer.addChild(new Text(this.theme.fg("accent", this.theme.bold("Custom response")), 1, 0));
      this.modeContainer.addChild(new Spacer(1));
      this.modeContainer.addChild(editor);

      this.updateHelpText();
      this.invalidate();
      this.tui.requestRender();
   }

   private setPromptScrollOffset(nextOffset: number): boolean {
      if (this.displayMode !== "overlay") return false;
      if (this.promptMaxScrollOffset <= 0) return false;
      const clamped = Math.max(0, Math.min(Math.floor(nextOffset), this.promptMaxScrollOffset));
      const changed = clamped !== this.promptScrollOffset;
      this.promptScrollOffset = clamped;
      return changed;
   }

   private handlePromptScrollInput(data: string): boolean {
      if (this.displayMode !== "overlay") return false;
      if (this.promptMaxScrollOffset <= 0) return false;
      // Prompt scrolling is select-mode only: in freeform mode the
      // editor owns PageUp/PageDown (tui.editor.pageUp/pageDown) for paging
      // through long input, so intercepting them here would steal editor keys.
      if (this.mode !== "select") return false;

      const pageRows = Math.max(1, this.promptViewportRows - 1);
      const halfPageRows = Math.max(1, Math.floor(this.promptViewportRows / 2));
      let handled = false;

      if (matchesKey(data, PROMPT_SCROLL_PAGE_UP_KEY)) {
         handled = true;
         this.setPromptScrollOffset(this.promptScrollOffset - pageRows);
      } else if (matchesKey(data, PROMPT_SCROLL_PAGE_DOWN_KEY)) {
         handled = true;
         this.setPromptScrollOffset(this.promptScrollOffset + pageRows);
      } else if (matchesKey(data, PROMPT_SCROLL_HOME_KEY)) {
         handled = true;
         this.setPromptScrollOffset(0);
      } else if (matchesKey(data, PROMPT_SCROLL_END_KEY)) {
         handled = true;
         this.setPromptScrollOffset(this.promptMaxScrollOffset);
      } else if (matchesKey(data, PROMPT_SCROLL_HALF_PAGE_UP_KEY)) {
         handled = true;
         this.setPromptScrollOffset(this.promptScrollOffset - halfPageRows);
      } else if (matchesKey(data, PROMPT_SCROLL_HALF_PAGE_DOWN_KEY)) {
         handled = true;
         this.setPromptScrollOffset(this.promptScrollOffset + halfPageRows);
      }

      return handled;
   }

   handleInput(data: string): void {
      if (this.handlePromptScrollInput(data)) {
         this.tui.requestRender();
         return;
      }
      if (this.mode === "freeform") {
         if (matchesKey(data, Key.escape)) {
            this.showSelectMode();
            return;
         }

         if (this.keybindings.matches(data, "tui.select.cancel")) {
            this.onDone(null);
            return;
         }

         this.ensureEditor().handleInput(data);
         this.tui.requestRender();
         return;
      }

      if (this.multiSelect) {
         this.ensureMultiSelectList().handleInput?.(data);
         this.tui.requestRender();
         return;
      }

      this.ensureSingleSelectList().handleInput?.(data);
      this.tui.requestRender();
   }
}

// Rows Pi's fullscreen layout keeps outside the input dock: the transcript's
// minimum row, the working status, and up to three footer rows.
const INLINE_DOCK_RESERVED_ROWS = 5;
// Answer rows the review page keeps before squeezing its footer.
const REVIEW_MIN_CONTENT_ROWS = 3;

/** Frame body lines in the ask_user_question box with the given title. */
function frameBox(theme: Theme, title: string, bodyLines: string[], width: number): string[] {
   const innerWidth = Math.max(1, width - BOX_BORDER_OVERHEAD);
   const borderColor = (s: string) => theme.fg("accent", s);
   return [
      new BoxBorderTop(borderColor, title, (s: string) => theme.fg("dim", theme.bold(s))).render(width)[0] ?? "",
      ...bodyLines.map((line) => `${borderColor(BOX_BORDER_LEFT)}${truncateToWidth(line, innerWidth, "", true)}${borderColor(BOX_BORDER_RIGHT)}`),
      new BoxBorderBottom(borderColor, `v${ASK_USER_VERSION}`, (s: string) => theme.fg("dim", s)).render(width)[0] ?? "",
   ];
}

/**
 * One prompt for a whole `questions` batch: a page per question plus a review
 * page when asking multiple questions. Each page is an AskComponent that stays alive,
 * so filters, drafts, and checkboxes survive moving between pages. Answers are
 * recorded per page; for multiple questions only the review page submits, while a single
 * question submits directly without a review page. Esc that would cancel a page cancels the batch.
 */
class BatchAskComponent implements Component {
   private pages: AskComponent[];
   private answers: Array<AskUIResponse | undefined>;
   private current = 0;
   private title = "";
   private confirmingSkips = false;
   private reviewScrollOffset = 0;
   private reviewMaxScrollOffset = 0;
   private _focused = false;

   constructor(
      private questions: BatchQuestion[],
      private settings: PromptSettings,
      private tui: TUI,
      private theme: Theme,
      private keybindings: KeybindingsManager,
      private onDone: (answers: AskAnswer[] | null) => void,
   ) {
      this.answers = questions.map(() => undefined);
      this.pages = questions.map((entry, index) => new AskComponent(
         entry.question,
         entry.header,
         entry.options,
         entry.multiSelect,
         settings.displayMode,
         settings.singleSelectLayout,
         tui,
         theme,
         keybindings,
         settings.shortcuts,
         (result) => this.handlePageDone(index, result),
      ));
      this.updateChrome();
   }

   get focused(): boolean {
      return this._focused;
   }
   set focused(value: boolean) {
      this._focused = value;
      const page = this.pages[this.current];
      if (page) page.focused = value;
   }

   invalidate(): void {
      for (const page of this.pages) page.invalidate();
   }

   render(width: number): string[] {
      const page = this.pages[this.current];
      return page ? page.render(width) : this.renderReview(width);
   }

   handleInput(data: string): void {
      if (this.questions.length > 1) {
         const pageCount = this.questions.length + 1;
         // Tab and shift+tab move between pages here; inside a page, arrows and
         // ctrl+j/k still move the option selection.
         if (matchesKey(data, Key.tab)) {
            this.goTo((this.current + 1) % pageCount);
            return;
         }
         if (matchesKey(data, Key.shift("tab"))) {
            this.goTo((this.current + pageCount - 1) % pageCount);
            return;
         }
      }
      const page = this.pages[this.current];
      if (page) {
         page.handleInput(data);
         return;
      }
      this.handleReviewInput(data);
   }

   private toAnswer(index: number, response: AskUIResponse): AskAnswer {
      return { question: this.questions[index]!.question, ...response };
   }

   /** Answered questions only, in question order; skips are omitted. */
   private answeredList(): AskAnswer[] {
      const result: AskAnswer[] = [];
      this.answers.forEach((response, index) => {
         if (response) result.push(this.toAnswer(index, response));
      });
      return result;
   }

   private handlePageDone(index: number, result: AskUIResult | null): void {
      if (result === null) {
         this.onDone(null);
         return;
      }
      this.answers[index] = result;
      if (this.questions.length === 1) {
         this.onDone([this.toAnswer(index, result)]);
         return;
      }
      const count = this.questions.length;
      for (let step = 1; step <= count; step++) {
         const next = (index + step) % count;
         if (!this.answers[next]) {
            this.goTo(next);
            return;
         }
      }
      this.goTo(count);
   }

   private goTo(target: number): void {
      const previous = this.pages[this.current];
      if (previous) {
         previous.focused = false;
         previous.leavePage();
      }
      this.current = target;
      this.confirmingSkips = false;
      this.reviewScrollOffset = 0;
      const next = this.pages[target];
      if (next) next.focused = this._focused;
      this.updateChrome();
      this.tui.requestRender();
   }

   private updateChrome(): void {
      // A single question keeps its own header as the frame title.
      if (this.questions.length <= 1) return;
      const labels = this.questions.map((_, index) => {
         const label = `${index + 1}${this.answers[index] ? "✓" : ""}`;
         return index === this.current ? `[${label}]` : label;
      });
      const review = this.current === this.questions.length ? "[review]" : "review";
      const strip = `${labels.join(" ")} · ${review}`;
      // On a question page the strip follows that page's header; the review
      // page belongs to no single question, so it shows the strip alone.
      const current = this.questions[this.current];
      this.title = current ? `${current.header} ${strip}` : strip;
      const hint = literalHint(this.theme, "tab/shift+tab", "questions");
      for (const page of this.pages) page.setBatchChrome(this.title, hint);
   }

   private unansweredCount(): number {
      return this.answers.filter((answer) => !answer).length;
   }

   private handleReviewInput(data: string): void {
      if (this.keybindings.matches(data, "tui.select.cancel")) {
         this.onDone(null);
         return;
      }
      if (this.keybindings.matches(data, "tui.select.confirm")) {
         if (this.unansweredCount() > 0 && !this.confirmingSkips) {
            this.confirmingSkips = true;
            this.tui.requestRender();
            return;
         }
         this.onDone(this.answeredList());
         return;
      }
      // Kitty's keyboard protocol can deliver digits as CSI-u sequences.
      const key = decodeKittyPrintable(data) ?? data;
      const jump = key.length === 1 ? Number.parseInt(key, 10) : Number.NaN;
      if (jump >= 1 && jump <= this.questions.length) {
         this.goTo(jump - 1);
         return;
      }
      const pageRows = Math.max(1, this.reviewLineCap() - 4);
      const scrollBy = matchesSelectUp(data, this.keybindings) ? -1
         : matchesSelectDown(data, this.keybindings) ? 1
            : matchesKey(data, PROMPT_SCROLL_PAGE_UP_KEY) ? -pageRows
               : matchesKey(data, PROMPT_SCROLL_PAGE_DOWN_KEY) ? pageRows
                  : 0;
      if (scrollBy !== 0) {
         this.reviewScrollOffset = Math.max(0, Math.min(this.reviewScrollOffset + scrollBy, this.reviewMaxScrollOffset));
         this.tui.requestRender();
      }
   }

   private renderReview(width: number): string[] {
      const theme = this.theme;
      const innerWidth = Math.max(1, width - BOX_BORDER_OVERHEAD);
      // Answer rows leave room for a two-cell overflow marker ("↑ ", "↓ ", "↕ "),
      // so marking a row never truncates its text. The footer is never marked.
      const wrap = (text: string) => wrapTextWithAnsi(text, Math.max(1, innerWidth - 2));
      const wrapFooter = (text: string) => wrapTextWithAnsi(text, innerWidth);
      const contentLines = [
         ...wrap(theme.fg("accent", theme.bold("Review answers"))),
         "",
      ];
      this.questions.forEach((entry, index) => {
         const response = this.answers[index];
         const marker = response ? theme.fg("success", "✓") : theme.fg("warning", "○");
         contentLines.push(...wrap(`${marker} ${theme.fg("text", `${index + 1}. ${entry.question}`)}`));
         contentLines.push(...wrap(response
            ? `   ${theme.fg("dim", "→")} ${theme.fg("accent", formatResponseSummary(response))}`
            : `   ${theme.fg("warning", "unanswered")}`));
      });

      const unanswered = this.unansweredCount();
      const overlayToggle = this.settings.shortcuts.overlayToggle;
      const hints = [
         keybindingHint(theme, this.keybindings, "tui.select.confirm", unanswered > 0 ? "submit with skips" : "submit"),
         literalHint(theme, this.questions.length > 1 ? `1-${this.questions.length}` : "1", "edit"),
         literalHint(theme, "tab/shift+tab", "questions"),
         this.settings.displayMode === "overlay" && !overlayToggle.disabled
            ? literalHint(theme, overlayToggle.spec, "hide")
            : null,
         keybindingHint(theme, this.keybindings, "tui.select.cancel", "cancel"),
      ].filter((hint): hint is string => !!hint).join(" • ");
      const warningText = this.confirmingSkips
         ? theme.fg("warning", `${unanswered} unanswered — press ${formatKeyList(this.keybindings.getKeys("tui.select.confirm"))} again to submit with skips`)
         : undefined;
      const hintText = theme.fg("dim", hints);
      const bodyCapacity = Math.max(1, this.reviewLineCap() - 2);
      let footerLines = ["", ...(warningText ? wrapFooter(warningText) : []), ...wrapFooter(hintText)];
      // On very short prompts keep room for answers: drop the spacer and keep
      // the warning and hints to one line each (frameBox truncates them).
      if (bodyCapacity - footerLines.length < REVIEW_MIN_CONTENT_ROWS) {
         footerLines = [...(warningText ? [warningText] : []), hintText];
      }

      // The answers scroll inside the cap while the footer stays visible.
      const contentBudget = Math.max(1, bodyCapacity - footerLines.length);
      this.reviewMaxScrollOffset = Math.max(0, contentLines.length - contentBudget);
      this.reviewScrollOffset = Math.min(this.reviewScrollOffset, this.reviewMaxScrollOffset);
      const visibleContent = contentLines.slice(this.reviewScrollOffset, this.reviewScrollOffset + contentBudget);
      const hiddenAbove = this.reviewScrollOffset > 0;
      const hiddenBelow = this.reviewScrollOffset < this.reviewMaxScrollOffset;
      // Mark overflow in front of the first and last visible rows instead of
      // replacing them, so even a one-row viewport still shows an answer.
      const marker = (symbol: string, line: string) => `${theme.fg("dim", symbol)} ${line}`;
      const last = visibleContent.length - 1;
      if (hiddenAbove && hiddenBelow && last === 0) {
         visibleContent[0] = marker("↕", visibleContent[0]!);
      } else {
         if (hiddenAbove) visibleContent[0] = marker("↑", visibleContent[0]!);
         if (hiddenBelow) visibleContent[last] = marker("↓", visibleContent[last]!);
      }
      return frameBox(theme, this.title, [...visibleContent, ...footerLines], width);
   }

   /** Rows the review page may use, borders included. */
   private reviewLineCap(): number {
      const rows = Number.isFinite(this.tui.terminal.rows) ? Math.floor(this.tui.terminal.rows) : 24;
      const overlayCap = getOverlayMaxRenderLinesForRows(rows);
      if (this.settings.displayMode === "overlay") return overlayCap;
      // Inline prompts sit in Pi's fullscreen input dock, which clips anything
      // taller than what remains after the transcript's minimum row, the
      // working status, and the 2-3 row footer. Components only learn their
      // width, so stay within that space instead of growing with the content.
      return Math.max(4, Math.min(overlayCap, rows - INLINE_DOCK_RESERVED_ROWS));
   }
}

type DialogOptions = { signal?: AbortSignal; timeout?: number };

/**
 * Options for the next dialog stage. Every call shares one deadline across all
 * questions and stages, so each stage gets only the time that is left (null
 * once it has passed), including calls with just one question.
 */
function dialogStageOptions(
   dialogOpts: DialogOptions | undefined,
   deadline: number | undefined,
): DialogOptions | undefined | null {
   if (deadline === undefined) return dialogOpts;
   const remaining = deadline - Date.now();
   return remaining > 0 ? { ...dialogOpts, timeout: remaining } : null;
}

/**
 * RPC/headless fallback: use dialog methods (select/input) instead of the rich TUI overlay.
 * ctx.ui.custom() returns undefined in RPC mode, so we degrade gracefully.
 */
async function askViaDialogs(
   ui: { select: Function; input: Function },
   question: string,
   options: QuestionOption[],
   multiSelect: boolean,
   dialogOpts?: DialogOptions,
   deadline?: number,
): Promise<AskUIResult | null> {
   if (dialogOpts?.signal?.aborted) return null;
   const prompt = question;

   if (multiSelect) {
      const optionList = formatOptionsForMessage(options);
      const selectionOpts = dialogStageOptions(dialogOpts, deadline);
      if (selectionOpts === null) return null;
      const rawSelections = await ui.input(
         `${prompt}\n\nOptions (select one or more):\n${optionList}`,
         "Type your selection(s)...",
         selectionOpts,
      ) as string | undefined;
      if (dialogOpts?.signal?.aborted || isCancelledInput(rawSelections)) return null;

      const selections = parseDialogSelections(rawSelections);
      if (selections.length === 0) return null;

      return createMultiResponse(selections);
   }

   const selectOptions = options.map((o) => o.label);
   selectOptions.push(FREEFORM_SENTINEL);

   const selectOpts = dialogStageOptions(dialogOpts, deadline);
   if (selectOpts === null) return null;
   const selected = await ui.select(prompt, selectOptions, selectOpts) as string | undefined;
   if (dialogOpts?.signal?.aborted || isCancelledInput(selected)) return null;

   if (selected === FREEFORM_SENTINEL) {
      const answerOpts = dialogStageOptions(dialogOpts, deadline);
      if (answerOpts === null) return null;
      const answer = await ui.input(prompt, "Type your answer...", answerOpts) as string | undefined;
      if (dialogOpts?.signal?.aborted || isCancelledInput(answer)) return null;
      return createCustomResponse(answer);
   }

   return createOptionResponse(selected);
}

/**
 * RPC/headless fallback for a `questions` batch: ask each question in turn
 * with the select()/input() dialogs. There is no review step here, so
 * cancelling any question cancels the whole batch, and every dialog stage
 * shares one deadline.
 */
async function askBatchViaDialogs(
   ui: { select: Function; input: Function },
   questions: BatchQuestion[],
   signal: AbortSignal | undefined,
   deadline: number | undefined,
): Promise<AskAnswer[] | null> {
   const dialogOpts = signal ? { signal } : undefined;
   const answers: AskAnswer[] = [];
   for (const [index, entry] of questions.entries()) {
      if (signal?.aborted) return null;
      const title = `(${index + 1}/${questions.length}) ${entry.question}`;
      const response = await askViaDialogs(
         ui,
         title,
         entry.options,
         entry.multiSelect,
         dialogOpts,
         deadline,
      );
      if (!response) return null;
      answers.push({ question: entry.question, ...response });
   }
   return answers;
}

interface PromptSettings {
   displayMode: AskDisplayMode;
   singleSelectLayout: AskSingleSelectLayout;
   timeout: number;
   shortcuts: ResolvedAskShortcuts;
}

/** Saved configuration, then existing environment variables, then built-in defaults. */
function resolvePromptSettings(config: AskUserConfig): PromptSettings {
   const envMode = process.env.PI_ASK_USER_DISPLAY_MODE?.trim().toLowerCase();
   const envDisplayMode: AskDisplayMode | undefined =
      envMode === "overlay" || envMode === "inline" ? envMode : undefined;
   const envSingleSelectLayout = process.env.PI_ASK_USER_SINGLE_SELECT_LAYOUT?.trim().toLowerCase();
   return {
      displayMode: config.displayMode ?? envDisplayMode ?? ASK_USER_DEFAULTS.displayMode,
      singleSelectLayout: config.singleSelectLayout ?? (envSingleSelectLayout === "list" ? "list" : ASK_USER_DEFAULTS.singleSelectLayout),
      timeout: config.timeout ?? ASK_USER_DEFAULTS.timeout,
      shortcuts: {
         overlayToggle: resolveShortcut(
            config.overlayToggleKey,
            process.env.PI_ASK_USER_OVERLAY_TOGGLE_KEY,
            DEFAULT_OVERLAY_TOGGLE_KEY,
         ),
      },
   };
}

/** Report the session as blocked on the user (`herdr:blocked`) for the duration of `run`. */
async function whileBlocked<T>(pi: ExtensionAPI, run: () => Promise<T>): Promise<T> {
   pi.events.emit("herdr:blocked", { active: true, label: "Waiting for user response" });
   try {
      return await run();
   } finally {
      pi.events.emit("herdr:blocked", { active: false });
   }
}

interface CustomPromptRequest<T> {
   signal?: AbortSignal;
   timeout?: number;
   displayMode: AskDisplayMode;
   overlayToggle: ResolvedShortcut;
   createComponent: (
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      complete: (value: T | null) => void,
   ) => Component;
   /** RPC/headless mode: ctx.ui.custom() returns undefined, so degrade to the select()/input() dialogs. */
   fallback: () => Promise<T | null>;
}

/**
 * Show one custom-UI prompt and own every resource it needs: the abort
 * listener, the timeout timer, and the overlay-toggle terminal listener.
 * Completion is guarded so a late timer, abort, or keypress cannot resolve
 * twice, and every resource is released however the prompt ends.
 */
async function runCustomPrompt<T>(ui: ExtensionUIContext, request: CustomPromptRequest<T>): Promise<T | null> {
   const { signal, timeout, displayMode, overlayToggle } = request;
   let overlayHandle: OverlayHandle | undefined;
   let removeOverlayInputListener: (() => void) | undefined;
   let customTimer: ReturnType<typeof setTimeout> | undefined;
   let onCustomAbort: (() => void) | undefined;
   let customCompleted = false;
   let hasAnnouncedHide = false;
   try {
      const customFactory = (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: T | null) => void) => {
         const complete = (value: T | null) => {
            if (customCompleted) return;
            customCompleted = true;
            done(signal?.aborted ? null : value);
         };
         if (signal) {
            onCustomAbort = () => complete(null);
            signal.addEventListener("abort", onCustomAbort, { once: true });
         }

         if (signal?.aborted) {
            complete(null);
         } else if (timeout && timeout > 0) {
            customTimer = setTimeout(() => complete(null), timeout);
         }

         return request.createComponent(tui, theme, keybindings, complete);
      };

      // Register a raw terminal input listener for the overlay-toggle key so the
      // overlay can be toggled even while it is hidden (hidden overlays do not
      // receive input). Inline mode does not need this because the prompt is
      // already non-modal. Skipped entirely if the user disabled the shortcut.
      if (
         displayMode === "overlay"
         && !overlayToggle.disabled
         && typeof ui.onTerminalInput === "function"
      ) {
         removeOverlayInputListener = ui.onTerminalInput((data) => {
            if (!overlayToggle.matches(data) || !overlayHandle) return undefined;
            // Kitty's progressive keyboard protocol reports press, repeat,
            // and release as separate events. Toggle only on the initial
            // press; otherwise one physical keypress can immediately hide
            // and re-show the overlay. Still consume repeat/release events
            // so they do not reach the component focused behind it.
            if (isKeyRepeat(data) || isKeyRelease(data)) return { consume: true };
            const nextHidden = !overlayHandle.isHidden();
            overlayHandle.setHidden(nextHidden);
            if (nextHidden && !hasAnnouncedHide) {
               hasAnnouncedHide = true;
               ui.notify?.(`ask_user_question hidden — press ${overlayToggle.spec} to reopen`, "info");
            }
            return { consume: true };
         });
      }

      const customResult = signal?.aborted ? null : await ui.custom<T | null>(
         customFactory,
         buildCustomUIOptions(displayMode, (handle) => {
            overlayHandle = handle;
         }),
      );

      if (signal?.aborted) return null;
      if (customResult !== undefined) return customResult;
      return await request.fallback();
   } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
   } finally {
      customCompleted = true;
      if (customTimer !== undefined) clearTimeout(customTimer);
      if (onCustomAbort) signal?.removeEventListener("abort", onCustomAbort);
      removeOverlayInputListener?.();
   }
}

/**
 * Validate and normalize a `questions` batch. Every problem throws before any
 * UI opens or event fires (#67), with a message that tells the model how to
 * correct the call.
 */
function normalizeBatchQuestions(params: AskParams): BatchQuestion[] {
   const { questions } = params;
   const configured = ASK_USER_SETTING_KEYS.filter((field) => Object.prototype.hasOwnProperty.call(params, field));
   if (configured.length > 0) {
      throw new Error(`${configured.join(", ")} are configuration settings, not ask_user_question parameters. Use /ask-user-question-settings to configure them.`);
   }
   const misplaced = BATCH_ENTRY_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(params, field));
   if (misplaced.length > 0) {
      throw new Error(
         `${misplaced.join(", ")} cannot be set at the top level. Set them on each questions entry instead, even when asking only one question.`,
      );
   }
   if (!Array.isArray(questions)) {
      throw new Error(`questions must be an array of ${BATCH_MIN_QUESTIONS}-${BATCH_MAX_QUESTIONS} question objects.`);
   }
   if (questions.length < BATCH_MIN_QUESTIONS) {
      throw new Error(
         `questions needs ${BATCH_MIN_QUESTIONS}-${BATCH_MAX_QUESTIONS} entries but got ${questions.length}. To ask one question, use a questions array with one entry.`,
      );
   }
   if (questions.length > BATCH_MAX_QUESTIONS) {
      throw new Error(
         `questions accepts at most ${BATCH_MAX_QUESTIONS} entries but got ${questions.length}. Ask the rest in a later ask_user_question call.`,
      );
   }

   const seen = new Set<string>();
   return questions.map((entry, index) => {
      const label = `questions[${index}]`;
      const question = typeof entry?.question === "string" ? entry.question.trim() : "";
      if (!question) throw new Error(`${label}.question must be a non-empty string.`);
      if (seen.has(question)) {
         throw new Error(`${label} repeats the question "${question}". Each question in a batch must be distinct.`);
      }
      seen.add(question);

      const header = typeof entry.header === "string" ? entry.header.trim() : "";
      if (!header) throw new Error(`${label}.header must be a non-empty string.`);

      const rawOptions = entry.options;
      if (!Array.isArray(rawOptions)) {
         throw new Error(`${label}.options must be an array of ${BATCH_MIN_OPTIONS}-${BATCH_MAX_OPTIONS} options.`);
      }
      if (rawOptions.length < BATCH_MIN_OPTIONS || rawOptions.length > BATCH_MAX_OPTIONS) {
         throw new Error(
            `${label}.options needs ${BATCH_MIN_OPTIONS}-${BATCH_MAX_OPTIONS} entries but got ${rawOptions.length}.`,
         );
      }
      const options = rawOptions.map((option) => coerceOption(option));
      const malformed = options.findIndex((option) => option === null);
      if (malformed !== -1) {
         throw new Error(
            `${label}.options[${malformed}] must be an object like `
            + `{ "label": "Short label", "description": "Why a user would pick it" }. `
            + `Call ask_user_question again with corrected options.`,
         );
      }
      const validOptions = options as QuestionOption[];

      const seenLabels = new Set<string>();
      for (const [optionIndex, option] of validOptions.entries()) {
         if (seenLabels.has(option.label)) {
            throw new Error(`${label}.options[${optionIndex}] repeats the label "${option.label}". Labels must be distinct within a question.`);
         }
         seenLabels.add(option.label);
         if ((RESERVED_OPTION_LABELS as readonly string[]).includes(option.label)) {
            throw new Error(`${label}.options[${optionIndex}] uses the reserved label "${option.label}". The prompt shows that row itself; pick a different label.`);
         }
      }

      return {
         question,
         header,
         options: validOptions,
         multiSelect: entry.multiSelect ?? false,
      };
   });
}

function formatAnswersForContent(details: AskResultDetails): string {
   if (details.cancelled) return "User cancelled the questions";
   const lines = details.answers.map((answer, index) =>
      `${index + 1}. ${answer.question} → ${formatResponseSummary(answer)}`);
   return [`User answered ${details.answers.length} questions:`, ...lines].join("\n");
}

function formatBatchForMessage(questions: BatchQuestion[]): string {
   const blocks = questions.map((entry, index) => {
      const lines = [`${index + 1}. ${entry.question}`];
      lines.push(`   Options${entry.multiSelect ? " (choose one or more)" : ""}:`);
      lines.push(...formatOptionsForMessage(entry.options).split("\n").map((line) => `   ${line}`));
      lines.push("   You can also answer freely.");
      return lines.join("\n");
   });
   return `ask_user_question requires interactive mode. Please answer these questions:\n\n${blocks.join("\n\n")}`;
}

async function executeBatch(
   pi: ExtensionAPI,
   questions: BatchQuestion[],
   settings: PromptSettings,
   signal: AbortSignal | undefined,
   onUpdate: AgentToolUpdateCallback<AskResultDetails> | undefined,
   ctx: ExtensionContext,
): Promise<AgentToolResult<AskResultDetails>> {
   if (!ctx.hasUI || !ctx.ui) {
      throw new Error(formatBatchForMessage(questions));
   }

   onUpdate?.({
      content: [{ type: "text", text: "Waiting for user input..." }],
      details: { answers: [], cancelled: false },
   });

   const deadline = settings.timeout > 0 ? Date.now() + settings.timeout : undefined;
   // One timer owns the batch deadline. It aborts the signal that every prompt
   // and dialog already listens to, so an open dialog closes exactly on time
   // (native dialog countdowns round up to whole seconds) and a late answer
   // cancels the batch. The caller's abort is forwarded to the same signal.
   const batch = new AbortController();
   const forwardAbort = () => batch.abort();
   signal?.addEventListener("abort", forwardAbort, { once: true });
   // An abort that already fired (for example inside onUpdate above) is not replayed.
   if (signal?.aborted) batch.abort();
   const deadlineTimer = deadline === undefined ? undefined : setTimeout(() => batch.abort(), settings.timeout);
   let answers: AskAnswer[] | null;
   try {
      answers = await whileBlocked(pi, () => runCustomPrompt<AskAnswer[]>(ctx.ui, {
         signal: batch.signal,
         displayMode: settings.displayMode,
         overlayToggle: settings.shortcuts.overlayToggle,
         createComponent: (tui, theme, keybindings, complete) =>
            new BatchAskComponent(questions, settings, tui, theme, keybindings, complete),
         fallback: () => askBatchViaDialogs(ctx.ui, questions, batch.signal, deadline),
      }));
   } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", forwardAbort);
   }

   if (batch.signal.aborted || answers === null) {
      return {
         content: [{ type: "text", text: "User cancelled the questions" }],
         details: { answers: [], cancelled: true },
      };
   }

   const details: AskResultDetails = { answers, cancelled: false };
   return {
      content: [{ type: "text", text: formatAnswersForContent(details) }],
      details,
   };
}

function formatResult(theme: Theme, details: AskResultDetails): string {
   if (details.cancelled) return theme.fg("warning", "Cancelled");
   let text = theme.fg("success", "✓ ")
      + theme.fg("accent", `${details.answers.length} answered`);
   details.answers.forEach((answer, index) => {
      text += `\n${theme.fg("dim", `${index + 1}.`)} ${theme.fg("muted", answer.question)}${theme.fg("dim", " → ")}`;
      if (answer.kind === "custom") {
         text += theme.fg("muted", "(wrote) ");
      }
      text += theme.fg("accent", formatResponseSummary(answer));
   });
   return text;
}

export default function(pi: ExtensionAPI) {
   const settingsStore = new AskUserSettingsStore(join(getAgentDir(), ASK_USER_SETTINGS_FILENAME));
   pi.registerCommand("ask-user-question-settings", {
      description: "Configure ask_user_question display, layout, shortcuts and timeout (saved globally)",
      handler: async (args, ctx) => {
         const reportError = (error: unknown) => ctx.ui.notify(`Cannot update ask_user_question settings (${settingsStore.path}): ${String(error)}`, "error");
         const save = (key: AskUserSettingKey, text: string) => {
            settingsStore.update(key, parseSettingValue(key, text));
            ctx.ui.notify(`ask_user_question ${key}: ${text.trim()} — saved to ${settingsStore.path}`, "info");
         };
         try {
            if (args.trim()) {
               const [key, ...words] = args.trim().split(/\s+/);
               if (!ASK_USER_SETTING_KEYS.includes(key as AskUserSettingKey) || words.length !== 1) {
                  ctx.ui.notify(`Usage: /ask-user-question-settings <${ASK_USER_SETTING_KEYS.join("|")}> <value|default>`, "warning");
                  return;
               }
               save(key as AskUserSettingKey, words[0]!);
               return;
            }
            if (!ctx.hasUI) {
               ctx.ui.notify("Use /ask-user-question-settings <setting> <value|default> when interactive dialogs are unavailable.", "warning");
               return;
            }
            while (true) {
               const config = settingsStore.read();
               const effective = resolvePromptSettings(config);
               const values = {
                  displayMode: effective.displayMode,
                  singleSelectLayout: effective.singleSelectLayout,
                  overlayToggleKey: effective.shortcuts.overlayToggle.spec ?? "off",
                  timeout: effective.timeout,
               };
               const choices = ASK_USER_SETTING_KEYS.map((key) => `${key}: ${values[key]}${Object.hasOwn(config, key) ? " (saved)" : " (environment/default)"}`);
               const selected = await ctx.ui.select("ask_user_question settings — saved globally", [...choices, "Done"]);
               const index = selected === undefined ? -1 : choices.indexOf(selected);
               if (index < 0) return;
               const key = ASK_USER_SETTING_KEYS[index]!;
               const options = key === "displayMode" ? ["inline", "overlay", "default"]
                  : key === "singleSelectLayout" ? ["auto", "list", "default"] : undefined;
               const value = options
                  ? await ctx.ui.select(`Configure ${key} (default restores environment/built-in fallback)`, options)
                  : await ctx.ui.input(
                     `Configure ${key}${key === "timeout" ? " in milliseconds (0 = no timeout)" : " (off = disabled)"}`,
                     `Current: ${values[key]}. Enter a value or default to restore fallback.`,
                  );
               if (value === undefined || value === null) continue;
               try {
                  save(key, value);
               } catch (error) {
                  reportError(error);
               }
            }
         } catch (error) {
            reportError(error);
         }
      },
   });

   // Flat object shape: union item schemas get stripped or rejected
   // by several providers/proxies (Google function calling,
   // Codex-style backends, cmux), leaving the model to guess the shape
   // and produce empty options. See issue #22.
   const optionSchema = Type.Object({
      label: Type.String({ description: "Short label for this option. This is the value returned when the user picks it." }),
      description: Type.String({ description: "One line explaining what choosing this option means" }),
      preview: Type.Optional(
         Type.String({ description: "Optional longer preview shown beside this option on wide terminals" }),
      ),
   });

   // Asks the user, so only the model may call it; codemode scripts cannot open prompts. Pi types `exposure` from
   // 1.0 and older hosts ignore it, so it is spread in to keep the definition valid against every supported host.
   const modelOnly: Record<string, unknown> = { exposure: "model-only" };
   pi.registerTool({
      ...modelOnly,
      name: "ask_user_question",
      label: "Ask User Question",
      description:
         "Ask the user 1-4 focused multiple-choice questions. Each question needs a header, a question, and 2-4 options with a label and a description. The user can always pick a free-form answer instead of the listed options. Multiple questions must be independent with settled prerequisites.",
      promptSnippet:
         "Ask the user 1-4 focused questions, each with 2-4 labelled options",
      promptGuidelines: [
         "Use ask_user_question when the user's intent is ambiguous, when a decision requires explicit user input, or when multiple valid options exist.",
         "Always use the questions array, with one focused question by default. Never pass question, header, options, or multiSelect at the top level.",
         "Every question needs a short header, the question text, and 2-4 options. Give each option a distinct label plus a description of its trade-off. The prompt adds its own free-form row, so never label an option \"Other\", \"Type something.\", or \"Next\".",
         "Set multiSelect only when the user may legitimately pick several options at once.",
         "When questions contains 2-4 entries, use it only for independent decisions whose prerequisites are already settled; ask anything that depends on another answer in a later ask_user_question call.",
         "Do not combine multiple numbered, multipart, or unrelated questions into one question's text.",
         "Display, layout, shortcuts and timeout are user settings managed by /ask-user-question-settings, not tool parameters. Do not pass them to ask_user_question.",
      ],
      // Block other tool calls in the same assistant turn until the user answers,
      // so the model can't batch ask_user_question with bash/edit/write and let those run
      // (potentially with side effects) before the user sees the prompt.
      executionMode: "sequential",
      parameters: Type.Object({
         questions: Type.Array(
            Type.Object({
               question: Type.String({ description: "One focused question to ask the user" }),
               header: Type.String({ description: "Short group label shown above the question" }),
               options: Type.Array(
                  optionSchema,
                  {
                     minItems: BATCH_MIN_OPTIONS,
                     maxItems: BATCH_MAX_OPTIONS,
                     description: "2-4 distinct options for this question. The prompt always adds its own free-form choice, so do not add one here.",
                  },
               ),
               multiSelect: Type.Optional(
                  Type.Boolean({ description: "Allow selecting multiple options. Default: false" }),
               ),
            }),
            {
               minItems: BATCH_MIN_QUESTIONS,
               maxItems: BATCH_MAX_QUESTIONS,
               description: "Required array of 1-4 focused questions, even when asking only one. Set question, header, options, and multiSelect on each entry.",
            },
         ),
      }, { additionalProperties: false }),

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
         // Validate even an already-aborted call: removed fields are never accepted.
         const questions = normalizeBatchQuestions(params as AskParams);
         if (signal?.aborted) {
            return {
               content: [{ type: "text", text: "Cancelled" }],
               details: { answers: [], cancelled: true } as AskResultDetails,
            };
         }
         let config: AskUserConfig = {};
         try {
            config = settingsStore.read();
         } catch (error) {
            ctx.ui?.notify?.(`Cannot load ask_user_question settings from ${settingsStore.path}: ${String(error)}. Using environment/default settings.`, "warning");
         }
         return executeBatch(pi, questions, resolvePromptSettings(config), signal, onUpdate, ctx);
      },

      renderCall(args, theme) {
         const entries: unknown[] = Array.isArray(args.questions) ? args.questions : [];
         let text = theme.fg("toolTitle", theme.bold("ask_user_question "));
         text += theme.fg("muted", `${entries.length} questions`);
         entries.forEach((entry, index) => {
            const record = (entry ?? {}) as { question?: unknown; header?: unknown; options?: unknown; multiSelect?: unknown };
            const question = typeof record.question === "string" ? record.question : "";
            const optionCount = Array.isArray(record.options) ? record.options.length : 0;
            const notes = [
               optionCount > 0 ? `${optionCount} option(s)` : "",
               record.multiSelect ? "multi-select" : "",
            ].filter(Boolean).join(", ");
            const header = typeof record.header === "string" && record.header ? ` [${record.header}]` : "";
            text += "\n" + theme.fg("dim", `  ${index + 1}.${header} ${question}${notes ? ` (${notes})` : ""}`);
         });
         return new Text(text, 0, 0);
      },

      renderResult(result, options, theme, context) {
         const details = result.details as (AskResultDetails | undefined);

         if (details?.error || context?.isError) {
            const message = details?.error ?? (
               result.content
                  ?.map((part) => part.type === "text" ? part.text : "")
                  .join("\n")
                  .trim() || "ask_user_question failed"
            );
            return new Text(theme.fg("error", `✗ ${message}`), 0, 0);
         }

         if (options.isPartial) {
            const waitingText = result.content
               ?.map((part) => part.type === "text" ? part.text : "")
               .join("\n")
               .trim() || "Waiting for user input...";
            return new Text(theme.fg("muted", waitingText), 0, 0);
         }

         if (!details) {
            return new Text(theme.fg("warning", "Cancelled"), 0, 0);
         }

         return new Text(formatResult(theme, details), 0, 0);
      },
   });
}
