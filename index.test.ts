import { beforeAll, describe, expect, mock, onTestFinished, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ASK_USER_SETTING_KEYS, ASK_USER_SETTINGS_FILENAME } from "./ask-user-settings";
import type { StringEnumBuilder } from "./index";

let editorInputs: string[] = [];
let editorText = "";
let emittedEvents: Array<{ name: string; payload: any }> = [];
let mockAgentDir = "";

function wrapPlainText(text: string, width = 80): string[] {
   const lines: string[] = [];
   for (const rawLine of text.split("\n")) {
      if (rawLine.length <= width) {
         lines.push(rawLine);
         continue;
      }
      for (let i = 0; i < rawLine.length; i += width) {
         lines.push(rawLine.slice(i, i + width));
      }
   }
   return lines.length > 0 ? lines : [""];
}

class MockText {
   constructor(private text: string) { }
   render(width = 80) {
      return wrapPlainText(this.text, width);
   }
   setText(text: string) {
      this.text = text;
   }
}

class MockContainer {
   private children: any[] = [];
   addChild(child?: any) {
      if (child) this.children.push(child);
   }
   clear() {
      this.children = [];
   }
   invalidate() { }
   render(width = 80) {
      return this.children.flatMap((child) => {
         if (typeof child?.render === "function") return child.render(width);
         return [];
      });
   }
}

class MockEditor {
   disableSubmit = false;
   onSubmit?: (text: string) => void;

   constructor(_tui: any, theme: any) {
      if (!theme?.borderColor) {
         throw new TypeError("Cannot read properties of undefined (reading 'borderColor')");
      }
   }

   handleInput(data?: string) {
      if (typeof data === "string") {
         editorInputs.push(data);
      }
      if (data === "enter") {
         // Mirror pi-tui's Editor.submitValue(): the buffer is cleared before
         // onSubmit fires, so anything reading getText() afterwards sees an
         // empty editor and must rely on the submitted text instead.
         const result = editorText.trim();
         editorText = "";
         this.onSubmit?.(result);
      }
   }
   getText() {
      return editorText;
   }
   setText(text = "") {
      editorText = text;
   }
   render(width = 80) {
      return [
         "─".repeat(width),
         ...wrapPlainText(editorText, Math.max(1, width - 1)),
         "─".repeat(width),
      ];
   }
}

function createKeybindings(overrides: Partial<Record<string, string[]>> = {}) {
   const bindings: Record<string, string[]> = {
      "tui.input.submit": ["enter"],
      "tui.input.newLine": ["shift+enter"],
      "tui.select.confirm": ["enter"],
      "tui.select.cancel": ["escape", "ctrl+c"],
      "tui.select.up": ["up"],
      "tui.select.down": ["down"],
      "tui.editor.deleteCharBackward": ["backspace"],
      ...overrides,
   };

   return {
      matches(data: string, keybinding: string) {
         return (bindings[keybinding] ?? []).includes(data);
      },
      getKeys(keybinding: string) {
         return bindings[keybinding] ?? [];
      },
   };
}

beforeAll(() => {
   // Model the failure mode from https://github.com/edlsh/pi-ask-user/issues/17.
   // `getMarkdownTheme()` returns a bag of closures that read through a Proxy
   // over the host's theme singleton. When the extension's bundled copy of
   // `@earendil-works/pi-coding-agent` is a different module instance than
   // the host's (e.g. legacy `@mariozechner/*` host ≤ Pi 0.73.1, where npm
   // cannot dedupe across scopes), our copy's singleton is never initialised
   // and any property read throws "Theme not initialized. Call initTheme()
   // first." Constructing the bag itself succeeds; the throw surfaces lazily
   // on `mdTheme.bold(...)` from inside pi-tui's `Markdown.render`. The
   // extension MUST detect this and fall back to plain `Text` rendering.
   const uninitialisedTheme = new Proxy({}, {
      get(_target, prop) {
         throw new Error(`Theme not initialized. Call initTheme() first. (read ${String(prop)})`);
      },
   });
   const brokenMarkdownTheme = {
      bold: (text: string) => (uninitialisedTheme as any).bold(text),
      italic: (text: string) => (uninitialisedTheme as any).italic(text),
      heading: (text: string) => (uninitialisedTheme as any).fg("mdHeading", text),
   };

   mock.module("@earendil-works/pi-coding-agent", () => ({
      DynamicBorder: class { },
      getMarkdownTheme: () => brokenMarkdownTheme,
      getAgentDir: () => mockAgentDir,
      rawKeyHint: (key: string, description: string) => `${key} ${description}`,
   }));

   mock.module("@earendil-works/pi-tui", () => ({
      Container: MockContainer,
      CURSOR_MARKER: "\x1b_pi:c\x07",
      Editor: MockEditor,
      Key: {
         escape: "escape",
         enter: "enter",
         up: "up",
         down: "down",
         pageUp: "pageUp",
         pageDown: "pageDown",
         home: "home",
         end: "end",
         space: "space",
         backspace: "backspace",
         ctrl: (key: string) => `ctrl+${key}`,
         alt: (key: string) => `alt+${key}`,
         shift: (key: string) => `shift+${key}`,
         tab: "tab",
      },
      Markdown: class extends MockText {
         private mdTheme: any;
         constructor(text: string, _a: number, _b: number, theme: any) {
            super(text);
            this.mdTheme = theme;
         }
         render() {
            // Mirror pi-tui Markdown.render: invoke theme.bold during render
            // so #17-style regressions surface as render-time crashes in
            // tests instead of silently passing.
            return super.render().map((line) => this.mdTheme.bold(line));
         }
      },
      matchesKey: (data: string, key: string) => data === key
         || (key === "alt+o" && /^\x1b\[111;3:[123]u$/.test(data)),
      isKeyRepeat: (data: string) => data.includes(":2u"),
      isKeyRelease: (data: string) => data.includes(":3u"),
      Spacer: class {
         render() {
            return [""];
         }
      },
      Text: MockText,
      truncateToWidth: (text: string) => text,
      // Mirrors pi-tui's cell counting closely enough for header layout tests:
      // strip ANSI, then charge two cells for wide/fullwidth characters.
      visibleWidth: (text: string) => [...text.replace(/\x1b\[[0-9;]*m/g, "")]
         .reduce((total, character) => total + (
            /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(character)
            || [...character].every((unit) => unit.codePointAt(0)! > 0xFFFF) ? 2 : 1
         ), 0),
      wrapTextWithAnsi: (text: string, width = 80) => wrapPlainText(text, width),
      decodeKittyPrintable: (data: string) => (data.length === 1 ? data : undefined),
      fuzzyFilter: <T>(items: T[], query: string, getText: (item: T) => string) => {
         const normalized = query.trim().toLowerCase();
         if (!normalized) return items;
         return items.filter((item) => getText(item).toLowerCase().includes(normalized));
      },
   }));

   const optional = Symbol("optional schema");
   mock.module("@sinclair/typebox", () => ({
      Type: {
         Object: (properties: Record<string, any>, settings = {}) => ({
            type: "object",
            properties,
            required: Object.keys(properties).filter((key) => !properties[key][optional]),
            ...settings,
         }),
         String: (settings = {}) => ({ type: "string", ...settings }),
         Optional: (value: any) => ({ ...value, [optional]: true }),
         Array: (items: unknown, settings = {}) => ({ type: "array", items, ...settings }),
         Union: (anyOf: unknown) => ({ anyOf }),
         Literal: (value: unknown) => ({ const: value }),
         Boolean: (settings = {}) => ({ type: "boolean", ...settings }),
         Number: (settings = {}) => ({ type: "number", ...settings }),
         Unsafe: (value: unknown) => value,
      },
   }));
});

type RegisteredTool = {
   execute: (...args: any[]) => Promise<any>;
   renderCall: (args: any, theme: any) => any;
   renderResult: (result: any, options: any, theme: any, context?: any) => any;
   parameters: any;
   executionMode: string;
   settingsCommand: { handler: (args: string, ctx: any) => Promise<void> };
   settingsPath: string;
   configureSettings: (config: Record<string, unknown>) => void;
};

function stubEnv(key: string, value: string | undefined): void {
   const original = process.env[key];
   if (value === undefined) delete process.env[key];
   else process.env[key] = value;
   onTestFinished(() => {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
   });
}

async function setupTool(initialSettings: Record<string, unknown> = {}): Promise<RegisteredTool> {
   const { default: askUserExtension } = await import("./index");
   const agentDir = mkdtempSync(join(process.cwd(), ".ask-user-test-"));
   mockAgentDir = agentDir;
   onTestFinished(() => rmSync(agentDir, { recursive: true, force: true }));
   let registeredTool: RegisteredTool | undefined;
   let settingsCommand: RegisteredTool["settingsCommand"] | undefined;
   emittedEvents = [];
   const pi = {
      registerCommand(name: string, command: RegisteredTool["settingsCommand"]) {
         expect(name).toBe("ask-user-question-settings");
         settingsCommand = command;
      },
      registerTool(tool: RegisteredTool) { registeredTool = tool; },
      events: {
         emit(name: string, payload: any) { emittedEvents.push({ name, payload }); },
      },
   } as any;

   askUserExtension(pi);

   if (!registeredTool) throw new Error("Tool was not registered");
   if (!settingsCommand) throw new Error("Settings command was not registered");

   const tool = Object.assign(registeredTool, {
      settingsCommand,
      settingsPath: join(agentDir, ASK_USER_SETTINGS_FILENAME),
      configureSettings(config: Record<string, unknown>) {
         for (const [key, value] of Object.entries(config)) {
            let error: string | undefined;
            void settingsCommand!.handler(`${key} ${value === undefined ? "default" : value === null ? "off" : value}`, {
               hasUI: true,
               ui: { notify(message: string, type: string) { if (type === "error" || type === "warning") error = message; } },
            });
            if (error) throw new Error(error);
         }
      },
   });
   tool.configureSettings(initialSettings);
   return tool;
}

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
   try {
      await promise;
   } catch (error) {
      if (error instanceof Error) return error;
      throw new Error(`Expected an Error rejection, received ${String(error)}`);
   }
   throw new Error("Expected promise to reject");
}

function createTheme() {
   return { fg: (_color: string, text: string) => text, bold: (text: string) => text };
}

// ---- Fixture builders for the current contract ---------------------------

function opt(label: string, description?: string, preview?: string) {
   return preview === undefined
      ? { label, description: description ?? `${label} detail` }
      : { label, description: description ?? `${label} detail`, preview };
}
/** Two valid options, the minimum the schema accepts. */
function opts2(a = "Alpha", b = "Beta") { return [opt(a), opt(b)]; }
/** One questions entry; header defaults to the question text. */
function entry(question: string, options = opts2(), extra: Record<string, unknown> = {}) {
   return { question, header: question, options, ...extra };
}
/** A full tool payload holding exactly one question. */
function oneQuestion(extra: Record<string, unknown> = {}) {
   const { question = "Continue?", options, ...rest } = extra;
   return { questions: [entry(question as string, (options as any) ?? opts2(), rest)] };
}
/** A full tool payload with several questions. */
function batch(entries: Array<Record<string, unknown>>) {
   return { questions: entries.map((each) => entry((each.question as string) ?? "Q?", each.options as any, each)) };
}

/** Mounts the prompt synchronously; drive keys through `state.component`. */
function mountPrompt(rows = 24) {
   const state: { component?: any; settled: boolean; answers: any } = { settled: false, answers: null };
   const custom = async (factory: any) => await new Promise((resolve) => {
      state.component = factory(
         { requestRender() { }, terminal: { rows } },
         createTheme(),
         createKeybindings(),
         (value: unknown) => {
            state.settled = true;
            state.answers = value;
            resolve(value);
         },
      );
   });
   return { state, ui: { custom } };
}

const press = (component: any, ...keys: string[]) => keys.forEach((key) => component.handleInput(key));

// ==========================================================================
// Registration and schema contract
// ==========================================================================

describe("ask_user_question registration and schema", () => {
   test("registers as ask_user_question with executionMode 'sequential'", async () => {
      const tool = await setupTool();
      expect((tool as any).name).toBe("ask_user_question");
      expect(tool.executionMode).toBe("sequential");
   });

   test("exposes questions as the only top-level parameter", async () => {
      const tool = await setupTool();
      expect(tool.parameters.required).toEqual(["questions"]);
      expect(tool.parameters.additionalProperties).toBe(false);
      expect(Object.keys(tool.parameters.properties).sort()).toEqual(["questions"]);
   });

   test("questions items require question, header and 2-4 options", async () => {
      const tool = await setupTool();
      const items = tool.parameters.properties.questions.items;
      expect(items.type).toBe("object");
      expect([...items.required].sort()).toEqual(["header", "options", "question"]);
      expect(items.properties.options.minItems).toBe(2);
      expect(items.properties.options.maxItems).toBe(4);
      expect([...items.properties.options.items.required].sort()).toEqual(["description", "label"]);
      expect(items.properties.options.items.properties.preview).toBeTruthy();
      expect(tool.parameters.properties.questions.minItems).toBe(1);
      expect(tool.parameters.properties.questions.maxItems).toBe(4);
   });

   test("multiSelect is optional and boolean", async () => {
      const tool = await setupTool();
      const items = tool.parameters.properties.questions.items;
      expect(items.properties.multiSelect.type).toBe("boolean");
      expect(items.required).not.toContain("multiSelect");
   });

   test("emits the herdr:blocked lifecycle around an answer", async () => {
      const tool = await setupTool();
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", oneQuestion(), undefined, undefined, { hasUI: true, ui });
      press(state.component, "enter");
      await execution;
      expect(emittedEvents.filter((event) => event.name === "herdr:blocked")).toEqual([
         { name: "herdr:blocked", payload: { active: true, label: "Waiting for user response" } },
         { name: "herdr:blocked", payload: { active: false } },
      ]);
   });

   test("clears herdr:blocked when the UI rejects", async () => {
      const tool = await setupTool();
      const error = await rejectedError(tool.execute("id", oneQuestion(), undefined, undefined, {
         hasUI: true,
         ui: { custom: async () => { throw new Error("UI failed"); } },
      }));
      expect(error.message).toBe("UI failed");
      expect(emittedEvents.filter((event) => event.name === "herdr:blocked").map((event) => event.payload.active))
         .toEqual([true, false]);
   });

   test("throws when interactive UI is unavailable", async () => {
      const tool = await setupTool();
      const error = await rejectedError(tool.execute("id", oneQuestion(), undefined, undefined, { hasUI: false }));
      expect(error.message).toContain("requires interactive mode");
      expect(error.message).toContain("You can also answer freely.");
   });

   test("no longer emits ask:* events", async () => {
      const tool = await setupTool();
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", oneQuestion(), undefined, undefined, { hasUI: true, ui });
      press(state.component, "enter");
      await execution;
      expect(emittedEvents.some((event) => event.name.startsWith("ask:"))).toBe(false);
   });
});

// ==========================================================================
// Input validation
// ==========================================================================

describe("ask_user_question validation", () => {
   async function rejects(params: any, message: string) {
      const tool = await setupTool();
      let opened = 0;
      const open = async () => { opened++; return undefined; };
      const error = await rejectedError(tool.execute("id", params, undefined, undefined, {
         hasUI: true,
         ui: { custom: open, select: open, input: open },
      }));
      expect(error.message).toContain(message);
      expect(opened).toBe(0);
      return error;
   }

   test("requires a questions array", () => rejects({}, "questions must be an array"));
   test("rejects an empty questions array", () => rejects({ questions: [] }, "needs 1-4 entries"));
   test("rejects five questions", () => rejects(batch(["A?", "B?", "C?", "D?", "E?"].map((q) => ({ question: q }))), "at most 4"));
   test("rejects a non-array questions value", () => rejects({ questions: "First?" }, "must be an array"));
   test("rejects a blank question", () => rejects({ questions: [entry("  ")] }, "question must be a non-empty string"));
   test("rejects duplicate question text", () => rejects(batch([{ question: "Same?" }, { question: "Same?" }]), "repeats the question"));
   test("rejects a blank header", () => rejects({ questions: [{ question: "Q?", header: "  ", options: opts2() }] }, "header must be a non-empty string"));
   test("rejects a missing header", () => rejects({ questions: [{ question: "Q?", options: opts2() }] }, "header must be a non-empty string"));
   test("rejects fewer than two options", () => rejects({ questions: [{ question: "Q?", header: "h", options: [opt("Only")] }] }, "needs 2-4 entries"));
   test("rejects more than four options", () => rejects(
      { questions: [{ question: "Q?", header: "h", options: [opt("A"), opt("B"), opt("C"), opt("D"), opt("E")] }] },
      "needs 2-4 entries",
   ));
   test("rejects a non-array options value", () => rejects({ questions: [{ question: "Q?", header: "h", options: "Alpha" }] }, "must be an array"));
   test("rejects an option without a label", () => rejects(
      { questions: [{ question: "Q?", header: "h", options: [{ description: "no label" }, opt("B")] }] },
      "options[0] must be an object",
   ));
   test("rejects an option without a description", () => rejects(
      { questions: [{ question: "Q?", header: "h", options: [{ label: "A" }, opt("B")] }] },
      "options[0] must be an object",
   ));
   test("rejects duplicate labels within a question", () => rejects(
      { questions: [{ question: "Q?", header: "h", options: [opt("Yes"), opt("Yes", "other")] }] },
      'repeats the label "Yes"',
   ));
   test("accepts four options", async () => {
      const tool = await setupTool();
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", { questions: [entry("Q?", [opt("A"), opt("B"), opt("C"), opt("D")])] }, undefined, undefined, { hasUI: true, ui });
      press(state.component, "enter");
      const result = await execution;
      expect(result.details.answers).toEqual([{ question: "Q?", kind: "option", answer: "A" }]);
   });

   for (const reserved of ["Other", "Type something.", "Next"]) {
      test(`rejects the reserved label ${JSON.stringify(reserved)}`, () => rejects(
         { questions: [{ question: "Q?", header: "h", options: [opt(reserved), opt("Keep")] }] },
         `reserved label "${reserved}"`,
      ));
   }

   for (const field of ["question", "header", "options", "multiSelect"]) {
      test(`rejects ${field} at the top level`, () => rejects(
         { questions: [entry("Continue?")], [field]: null },
         `${field} cannot be set at the top level`,
      ));
   }

   for (const key of ASK_USER_SETTING_KEYS) {
      test(`rejects the setting ${key} as a tool parameter`, () => rejects(
         { questions: [entry("Continue?")], [key]: null },
         `${key} are configuration settings`,
      ));
   }

   test("validation runs even when the signal is already aborted", async () => {
      const tool = await setupTool();
      const controller = new AbortController();
      controller.abort();
      const error = await rejectedError(tool.execute(
         "id", { questions: [entry("Q?", [opt("Only")])] }, controller.signal, undefined,
         { hasUI: true, ui: { custom: async () => undefined } },
      ));
      expect(error.message).toContain("needs 2-4 entries");
   });

   test("an already-aborted valid call cancels without opening UI", async () => {
      const tool = await setupTool();
      const controller = new AbortController();
      controller.abort();
      let opened = 0;
      const result = await tool.execute("id", oneQuestion(), controller.signal, undefined, {
         hasUI: true, ui: { custom: async () => { opened++; return undefined; } },
      });
      expect(opened).toBe(0);
      expect(result.details).toEqual({ answers: [], cancelled: true });
   });
});

// ==========================================================================
// Result rendering
// ==========================================================================

describe("ask_user_question result rendering", () => {
   test("renders partial updates as a waiting state", async () => {
      const tool = await setupTool();
      const component = tool.renderResult(
         { content: [{ type: "text", text: "Waiting for user input..." }], details: { answers: [], cancelled: false } },
         { expanded: false, isPartial: true }, createTheme(),
      );
      expect(component.render(80).join("\n")).toContain("Waiting for user input...");
   });

   test("renders thrown failures as errors", async () => {
      const tool = await setupTool();
      const component = tool.renderResult(
         { content: [{ type: "text", text: "boom" }], details: { error: "boom" } },
         { expanded: false, isPartial: false }, createTheme(), { isError: true },
      );
      expect(component.render(80).join("\n")).toContain("boom");
   });

   test("renders a cancelled result", async () => {
      const tool = await setupTool();
      const component = tool.renderResult(
         { content: [], details: { answers: [], cancelled: true } },
         { expanded: false, isPartial: false }, createTheme(),
      );
      expect(component.render(80).join("\n")).toContain("Cancelled");
   });

   test("renders an option answer with its question", async () => {
      const tool = await setupTool();
      const component = tool.renderResult(
         { content: [], details: { answers: [{ question: "Continue?", kind: "option", answer: "Yes" }], cancelled: false } },
         { expanded: false, isPartial: false }, createTheme(),
      );
      const rendered = component.render(120).join("\n");
      expect(rendered).toContain("1 answered");
      expect(rendered).toContain("Continue?");
      expect(rendered).toContain("Yes");
   });

   test("renders a multi answer from its selected labels", async () => {
      const tool = await setupTool();
      const component = tool.renderResult(
         { content: [], details: { answers: [{ question: "Pick", kind: "multi", answer: null, selected: ["A", "C"] }], cancelled: false } },
         { expanded: false, isPartial: false }, createTheme(),
      );
      expect(component.render(120).join("\n")).toContain("A, C");
   });

   test("renders a custom answer with a wrote marker", async () => {
      const tool = await setupTool();
      const component = tool.renderResult(
         { content: [], details: { answers: [{ question: "Why?", kind: "custom", answer: "Because reasons" }], cancelled: false } },
         { expanded: false, isPartial: false }, createTheme(),
      );
      const rendered = component.render(120).join("\n");
      expect(rendered).toContain("(wrote)");
      expect(rendered).toContain("Because reasons");
   });

   test("renderCall lists questions, headers and option counts", async () => {
      const tool = await setupTool();
      const component = tool.renderCall(
         { questions: [entry("Continue?", opts2(), { header: "Release" }), entry("Also?", opts2("X", "Y"), { header: "Extra", multiSelect: true })] },
         createTheme(),
      );
      const rendered = component.render(140).join("\n");
      expect(rendered).toContain("2 questions");
      expect(rendered).toContain("[Release]");
      expect(rendered).toContain("2 option(s)");
      expect(rendered).toContain("multi-select");
   });
});

// ==========================================================================
// Settings command
// ==========================================================================

describe("/ask-user-question-settings", () => {
   function notifications() {
      const messages: Array<{ message: string; type: string }> = [];
      return { messages, notify(message: string, type: string) { messages.push({ message, type }); } };
   }

   test("default runtime settings are inline, auto, standard shortcut and no timeout", async () => {
      for (const key of ["PI_ASK_USER_DISPLAY_MODE", "PI_ASK_USER_SINGLE_SELECT_LAYOUT", "PI_ASK_USER_OVERLAY_TOGGLE_KEY"]) stubEnv(key, undefined);
      const tool = await setupTool();
      let captured: any;
      let uiOptions: any;
      await tool.execute("id", oneQuestion(), undefined, undefined, {
         hasUI: true,
         ui: {
            custom: async (factory: any, options: any) => {
               uiOptions = options;
               captured = factory({ requestRender() { }, terminal: { rows: 24 } }, createTheme(), createKeybindings(), () => { }).settings;
               return null;
            },
         },
      });
      expect(uiOptions).toBeUndefined();
      expect(captured).toMatchObject({ displayMode: "inline", singleSelectLayout: "auto", timeout: 0 });
      expect(captured.shortcuts.overlayToggle.spec).toBe("alt+o");
      expect(existsSync(tool.settingsPath)).toBe(false);
   });

   test("command updates all four settings and persisted values beat environment preferences", async () => {
      stubEnv("PI_ASK_USER_DISPLAY_MODE", "inline");
      stubEnv("PI_ASK_USER_SINGLE_SELECT_LAYOUT", "list");
      stubEnv("PI_ASK_USER_OVERLAY_TOGGLE_KEY", "alt+h");
      const tool = await setupTool({ displayMode: "overlay", singleSelectLayout: "auto", overlayToggleKey: "off", timeout: 5000 });
      expect(JSON.parse(readFileSync(tool.settingsPath, "utf8"))).toEqual({
         displayMode: "overlay", singleSelectLayout: "auto", overlayToggleKey: "off", timeout: 5000,
      });
      let captured: any;
      await tool.execute("id", oneQuestion(), undefined, undefined, {
         hasUI: true,
         ui: {
            custom: async (factory: any, options: any) => {
               expect(options.overlay).toBe(true);
               captured = factory({ requestRender() { }, terminal: { rows: 24 } }, createTheme(), createKeybindings(), () => { }).settings;
               return null;
            },
         },
      });
      expect(captured).toMatchObject({ displayMode: "overlay", singleSelectLayout: "auto", timeout: 5000 });
      expect(captured.shortcuts.overlayToggle.disabled).toBe(true);
   });

   test("default removes a saved override and restores the environment preference", async () => {
      stubEnv("PI_ASK_USER_DISPLAY_MODE", "overlay");
      const tool = await setupTool({ displayMode: "inline", timeout: 0 });
      const notices = notifications();
      await tool.settingsCommand.handler("displayMode default", { hasUI: true, ui: notices });
      expect(JSON.parse(readFileSync(tool.settingsPath, "utf8"))).toEqual({ timeout: 0 });
      await tool.execute("id", oneQuestion(), undefined, undefined, {
         hasUI: true, ui: { custom: async (_factory: any, options: any) => { expect(options.overlay).toBe(true); return null; } },
      });
      expect(notices.messages[0]?.type).toBe("info");
   });

   test("interactive menu edits values and saves before returning to the menu", async () => {
      const tool = await setupTool();
      const notices = notifications();
      let selections = 0;
      await tool.settingsCommand.handler("", {
         hasUI: true,
         ui: {
            ...notices,
            select: async (_title: string, options: string[]) => {
               selections++;
               if (selections === 1) return options.find((option) => option.startsWith("displayMode:"));
               if (selections === 2) return "overlay";
               expect(JSON.parse(readFileSync(tool.settingsPath, "utf8"))).toEqual({ displayMode: "overlay" });
               expect(options.some((option) => option === "displayMode: overlay (saved)")).toBe(true);
               return "Done";
            },
         },
      });
      expect(selections).toBe(3);
   });

   test("invalid command values preserve the configuration and report an error", async () => {
      const tool = await setupTool({ timeout: 5000 });
      const before = readFileSync(tool.settingsPath, "utf8");
      const notices = notifications();
      for (const args of ["timeout -1", "overlayToggleKey ++bad++", "displayMode fullscreen", "singleSelectLayout wide"]) {
         await tool.settingsCommand.handler(args, { hasUI: true, ui: notices });
      }
      expect(notices.messages.map((notice) => notice.type)).toEqual(["error", "error", "error", "error"]);
      expect(readFileSync(tool.settingsPath, "utf8")).toBe(before);
   });

   test("unknown keys and malformed command syntax do not write files", async () => {
      const tool = await setupTool();
      const notices = notifications();
      for (const args of ["contextExpanded true", "allowComment true", "displayMode", "timeout 5000 extra"]) {
         await tool.settingsCommand.handler(args, { hasUI: true, ui: notices });
      }
      expect(notices.messages.every((notice) => notice.type === "warning")).toBe(true);
      expect(existsSync(tool.settingsPath)).toBe(false);
   });

   test("menu without UI does not write settings", async () => {
      const tool = await setupTool();
      const notices = notifications();
      await tool.settingsCommand.handler("", { hasUI: false, ui: notices });
      expect(notices.messages[0]?.type).toBe("warning");
      expect(existsSync(tool.settingsPath)).toBe(false);
   });

   test("corrupt settings warn during execution but are never overwritten", async () => {
      stubEnv("PI_ASK_USER_DISPLAY_MODE", "inline");
      const tool = await setupTool();
      writeFileSync(tool.settingsPath, "{broken");
      const notices = notifications();
      await tool.settingsCommand.handler("displayMode overlay", { hasUI: true, ui: notices });
      expect(notices.messages[0]?.type).toBe("error");
      await tool.execute("id", oneQuestion(), undefined, undefined, {
         hasUI: true, ui: { ...notices, custom: async (_factory: any, options: any) => { expect(options).toBeUndefined(); return null; } },
      });
      expect(notices.messages.at(-1)?.type).toBe("warning");
      expect(readFileSync(tool.settingsPath, "utf8")).toBe("{broken");
   });

   test("command updates leave shared Pi settings unchanged", async () => {
      const tool = await setupTool();
      const sharedPath = join(dirname(tool.settingsPath), "settings.json");
      const shared = '{"model":"shared"}\n';
      writeFileSync(sharedPath, shared);
      await tool.settingsCommand.handler("displayMode overlay", { hasUI: true, ui: notifications() });
      expect(readFileSync(sharedPath, "utf8")).toBe(shared);
   });
});

// ==========================================================================
// Display mode resolution
// ==========================================================================

describe("display mode resolution", () => {
   async function captureOptions(tool: RegisteredTool) {
      let uiOptions: any;
      await tool.execute("id", oneQuestion(), undefined, undefined, {
         hasUI: true, ui: { custom: async (_factory: any, options: any) => { uiOptions = options; return null; } },
      });
      return uiOptions;
   }

   test("inline mode passes no overlay options", async () => {
      expect(await captureOptions(await setupTool({ displayMode: "inline" }))).toBeUndefined();
   });

   test("overlay mode passes centered overlay options", async () => {
      const options = await captureOptions(await setupTool({ displayMode: "overlay" }));
      expect(options.overlay).toBe(true);
      expect(options.overlayOptions.anchor).toBe("center");
   });

   test("PI_ASK_USER_DISPLAY_MODE applies when no saved displayMode exists", async () => {
      stubEnv("PI_ASK_USER_DISPLAY_MODE", "overlay");
      expect((await captureOptions(await setupTool())).overlay).toBe(true);
   });

   test("saved displayMode overrides PI_ASK_USER_DISPLAY_MODE", async () => {
      stubEnv("PI_ASK_USER_DISPLAY_MODE", "overlay");
      expect(await captureOptions(await setupTool({ displayMode: "inline" }))).toBeUndefined();
   });

   test("an unrecognised PI_ASK_USER_DISPLAY_MODE falls back to inline", async () => {
      stubEnv("PI_ASK_USER_DISPLAY_MODE", "sideways");
      expect(await captureOptions(await setupTool())).toBeUndefined();
   });
});

// ==========================================================================
// Overlay hide/show toggle
// ==========================================================================

describe("overlay hide/show toggle (alt+o)", () => {
   test("registers an onTerminalInput listener in overlay mode", async () => {
      const tool = await setupTool({ displayMode: "overlay" });
      let registered = 0;
      await tool.execute("id", oneQuestion(), undefined, undefined, {
         hasUI: true,
         ui: {
            onTerminalInput: () => { registered++; return () => { }; },
            custom: async () => null,
         },
      });
      expect(registered).toBe(1);
   });

   test("does not register onTerminalInput in inline mode", async () => {
      const tool = await setupTool({ displayMode: "inline" });
      let registered = 0;
      await tool.execute("id", oneQuestion(), undefined, undefined, {
         hasUI: true,
         ui: { onTerminalInput: () => { registered++; return () => { }; }, custom: async () => null },
      });
      expect(registered).toBe(0);
   });

   test("alt+o toggles overlay visibility via OverlayHandle.setHidden", async () => {
      const tool = await setupTool({ displayMode: "overlay" });
      let listener: any;
      const states: boolean[] = [];
      let hidden = false;
      const handle = { isHidden: () => hidden, setHidden(next: boolean) { hidden = next; states.push(next); } };
      await tool.execute("id", oneQuestion(), undefined, undefined, {
         hasUI: true,
         ui: {
            notify() { },
            onTerminalInput: (cb: any) => { listener = cb; return () => { }; },
            custom: async (_factory: any, options: any) => { options.onHandle?.(handle); return null; },
         },
      });
      expect(listener("alt+o")).toEqual({ consume: true });
      expect(listener("alt+o")).toEqual({ consume: true });
      expect(states).toEqual([true, false]);
   });

   test("overlayToggleKey 'off' disables the listener entirely", async () => {
      const tool = await setupTool({ displayMode: "overlay", overlayToggleKey: "off" });
      let registered = 0;
      await tool.execute("id", oneQuestion(), undefined, undefined, {
         hasUI: true,
         ui: { onTerminalInput: () => { registered++; return () => { }; }, custom: async () => null },
      });
      expect(registered).toBe(0);
   });
});

// ==========================================================================
// Single-select UI
// ==========================================================================

describe("single-select UI", () => {
   test("confirm selects the focused option", async () => {
      const tool = await setupTool();
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", oneQuestion({ question: "Pick?", options: opts2("Red", "Blue") }), undefined, undefined, { hasUI: true, ui });
      press(state.component, "enter");
      const result = await execution;
      expect(result.details).toEqual({ answers: [{ question: "Pick?", kind: "option", answer: "Red" }], cancelled: false });
   });

   test("down then confirm selects the second option", async () => {
      const tool = await setupTool();
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", oneQuestion({ question: "Pick?", options: opts2("Red", "Blue") }), undefined, undefined, { hasUI: true, ui });
      press(state.component, "down", "enter");
      const result = await execution;
      expect(result.details.answers).toEqual([{ question: "Pick?", kind: "option", answer: "Blue" }]);
   });

   test("typed search filters before confirming", async () => {
      const tool = await setupTool();
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", oneQuestion({ question: "Pick?", options: [opt("Chrome"), opt("Firefox"), opt("Safari")] }), undefined, undefined, { hasUI: true, ui });
      press(state.component, "f", "enter");
      const result = await execution;
      expect(result.details.answers).toEqual([{ question: "Pick?", kind: "option", answer: "Firefox" }]);
   });

   test("the free-form row is always last and opens the editor", async () => {
      const tool = await setupTool();
      editorText = "";
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", oneQuestion({ question: "Pick?", options: opts2("Red", "Blue") }), undefined, undefined, { hasUI: true, ui });
      press(state.component, "down", "down", "enter"); // two options, then free-form
      expect(state.settled).toBe(false);
      editorText = "Neither of those";
      press(state.component, "enter");
      const result = await execution;
      expect(result.details.answers).toEqual([{ question: "Pick?", kind: "custom", answer: "Neither of those" }]);
   });

   test("the free-form row is numbered and shows a placeholder while empty", async () => {
      const tool = await setupTool();
      editorText = "";
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", oneQuestion({ question: "Pick?", options: opts2("Red", "Blue") }), undefined, undefined, { hasUI: true, ui });
      // Render narrow so the single-column list keeps the hint row; the wide
      // split-pane layout hides descriptions by design.
      const rendered = state.component.render(60).join("\n");
      // Two options, so the free-form row carries number 3.
      expect(rendered).toMatch(/3\.\s+Type something\./);
      expect(rendered).toContain("Enter a custom response");
      press(state.component, "escape");
      await execution;
   });

   test("the free-form row shows the typed draft instead of the placeholder", async () => {
      const tool = await setupTool();
      editorText = "";
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", oneQuestion({ question: "Pick?", options: opts2("Red", "Blue") }), undefined, undefined, { hasUI: true, ui });
      press(state.component, "down", "down", "enter"); // open the editor
      editorText = "use syslog";
      press(state.component, "escape");                // back to the list
      const rendered = state.component.render(100).join("\n");
      expect(rendered).toMatch(/3\.\s+use syslog/);
      expect(rendered).not.toContain("Type something.");
      expect(rendered).not.toContain("Enter a custom response");
      press(state.component, "escape");
      await execution;
   });

   test("the multi-select free-form row is numbered, tickable and shows a placeholder while empty", async () => {
      const tool = await setupTool();
      editorText = "";
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", oneQuestion({ question: "Pick?", options: [opt("A"), opt("B"), opt("C")], multiSelect: true }), undefined, undefined, { hasUI: true, ui });
      // Render narrow so the single-column list keeps the hint row; the wide
      // split-pane layout hides descriptions by design.
      const rendered = state.component.render(60).join("\n");
      expect(rendered).toMatch(/4\.\s+\[ ]\s+Type something\./);
      expect(rendered).toContain("Enter a custom response");
      press(state.component, "escape");
      await execution;
   });

   test("ctrl+k at the top wraps to the free-form row", async () => {
      const tool = await setupTool();
      editorText = "";
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", oneQuestion({ question: "Pick?", options: opts2("Red", "Blue") }), undefined, undefined, { hasUI: true, ui });
      press(state.component, "ctrl+k", "enter");
      expect(state.settled).toBe(false);
      editorText = "Wrapped";
      press(state.component, "enter");
      const result = await execution;
      expect(result.details.answers).toEqual([{ question: "Pick?", kind: "custom", answer: "Wrapped" }]);
   });

   test("a blank free-form answer cancels instead of resolving", async () => {
      const tool = await setupTool();
      editorText = "   ";
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", oneQuestion({ options: opts2("Red", "Blue") }), undefined, undefined, { hasUI: true, ui });
      press(state.component, "down", "down", "enter");
      press(state.component, "enter"); // submits blank editorText
      const result = await execution;
      expect(result.details).toEqual({ answers: [], cancelled: true });
   });

   test("escape cancels from the select list", async () => {
      const tool = await setupTool();
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", oneQuestion(), undefined, undefined, { hasUI: true, ui });
      press(state.component, "escape");
      const result = await execution;
      expect(result.details).toEqual({ answers: [], cancelled: true });
   });

   test("escape from free-form returns to the select list", async () => {
      const tool = await setupTool();
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", oneQuestion({ options: opts2("Red", "Blue") }), undefined, undefined, { hasUI: true, ui });
      press(state.component, "down", "down", "enter"); // enter free-form
      expect(state.settled).toBe(false);
      press(state.component, "escape");                // back to the list
      expect(state.settled).toBe(false);
      press(state.component, "up", "up", "enter");      // move to an option and confirm
      const result = await execution;
      expect(result.details.answers).toEqual([{ question: "Continue?", kind: "option", answer: "Red" }]);
   });

   test("shows the header in the frame title above the question", async () => {
      const tool = await setupTool();
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", oneQuestion({ question: "Pick?", header: "Deploy target" }), undefined, undefined, { hasUI: true, ui });
      const rendered = state.component.render(100).join("\n");
      expect(rendered).toContain("Deploy target");
      // The header is the border title, so it precedes the question and no
      // separate header row is rendered.
      expect(rendered.indexOf("Deploy target")).toBeLessThan(rendered.indexOf("Pick?"));
      expect(rendered.indexOf("Deploy target")).toBeLessThan(rendered.indexOf("\n│ "));
      // A blank row separates the header from the question.
      const rows: string[] = state.component.render(100);
      const questionRow = rows.findIndex((line) => line.includes("Pick?"));
      expect(rows[questionRow - 1]).toMatch(/^│\s*│$/);
      press(state.component, "enter");
      await execution;
   });

   test("the frame title keeps the header verbatim instead of uppercasing it", async () => {
      const tool = await setupTool();
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", oneQuestion({ header: "Deploy Target" }), undefined, undefined, { hasUI: true, ui });
      const rendered = state.component.render(100).join("\n");
      expect(rendered).toContain("Deploy Target");
      expect(rendered).not.toContain("DEPLOY TARGET");
      press(state.component, "escape");
      await execution;
   });

   // Border-title cell alignment for CJK, fullwidth and emoji headers, its
   // truncation when overflowing, and the plain-border fallback on very narrow
   // prompts are asserted against the host's genuine pi-tui in
   // scripts/host-smoke.mjs. The mocked truncateToWidth here is an identity
   // function, so those paths cannot be verified from this suite.
});

// ==========================================================================
// Multi-select UI
// ==========================================================================

describe("multi-select UI", () => {
   test("space toggles options and confirm returns a multi answer", async () => {
      const tool = await setupTool();
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", oneQuestion({ question: "Pick?", options: [opt("A"), opt("B"), opt("C")], multiSelect: true }), undefined, undefined, { hasUI: true, ui });
      press(state.component, "space", "down", "down", "space", "enter");
      const result = await execution;
      expect(result.details.answers).toEqual([{ question: "Pick?", kind: "multi", answer: null, selected: ["A", "C"] }]);
   });

   test("confirming with nothing checked falls back to the focused option", async () => {
      const tool = await setupTool();
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", oneQuestion({ question: "Pick?", options: [opt("A"), opt("B")], multiSelect: true }), undefined, undefined, { hasUI: true, ui });
      press(state.component, "down", "enter");
      const result = await execution;
      expect(result.details.answers).toEqual([{ question: "Pick?", kind: "multi", answer: null, selected: ["B"] }]);
   });

   test("the free-form editor records the draft on the ticked row instead of submitting", async () => {
      const tool = await setupTool();
      editorText = "";
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", oneQuestion({ question: "Pick?", options: [opt("A"), opt("B")], multiSelect: true }), undefined, undefined, { hasUI: true, ui });
      press(state.component, "down", "down", "enter"); // two options, then free-form
      editorText = "Something else";
      press(state.component, "enter");                // records, does not submit
      expect(state.settled).toBe(false);
      const page = (state.component as any).pages[0];
      expect(page.mode).toBe("select");
      expect(page.freeformDraft).toBe("Something else");
      const rendered = state.component.render(100).join("\n");
      expect(rendered).toMatch(/3\.\s+\[✓\]\s+Something else/);
      // Enter on the free-form row edits the text again, like single-select.
      press(state.component, "enter");
      expect((state.component as any).pages[0].mode).toBe("freeform");
      press(state.component, "escape");
      // Confirming from an option row submits the custom text alone.
      press(state.component, "up", "enter");
      const result = await execution;
      expect(result.details.answers).toEqual([{ question: "Pick?", kind: "custom", answer: "Something else" }]);
   });

   test("a ticked free-form draft joins ticked options as one multi answer", async () => {
      const tool = await setupTool();
      editorText = "";
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", oneQuestion({ question: "Pick?", options: [opt("A"), opt("B")], multiSelect: true }), undefined, undefined, { hasUI: true, ui });
      press(state.component, "space");                 // tick A
      press(state.component, "down", "down", "enter"); // free-form editor
      editorText = "and also this";
      press(state.component, "enter");                 // back to the list, row ticked
      press(state.component, "up", "enter");           // confirm from an option row
      const result = await execution;
      expect(result.details.answers).toEqual([
         { question: "Pick?", kind: "multi", answer: null, selected: ["A", "and also this"] },
      ]);
   });

   test("unticking the free-form row keeps the draft but drops it from the answer", async () => {
      const tool = await setupTool();
      editorText = "";
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", oneQuestion({ question: "Pick?", options: [opt("A"), opt("B")], multiSelect: true }), undefined, undefined, { hasUI: true, ui });
      press(state.component, "space");                 // tick A
      press(state.component, "down", "down", "enter"); // free-form editor
      editorText = "draft kept";
      press(state.component, "enter");                 // row ticked with draft
      press(state.component, "space");                 // untick the free-form row
      press(state.component, "up", "enter");           // confirm from an option row
      const result = await execution;
      expect(result.details.answers).toEqual([
         { question: "Pick?", kind: "multi", answer: null, selected: ["A"] },
      ]);
   });

   test("a batch single-select page keeps its submitted free-form text when revisited", async () => {
      const tool = await setupTool();
      editorText = "";
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", batch([
         { question: "First?", options: opts2("A", "B") },
         { question: "Second?", options: opts2("X", "Y") },
      ]), undefined, undefined, { hasUI: true, ui });
      press(state.component, "down", "down", "enter"); // free-form editor on page 1
      editorText = "use syslog";
      press(state.component, "enter");                 // submits page 1, advances
      press(state.component, "shift+tab");             // back to page 1
      const page = (state.component as any).pages[0];
      expect(page.mode).toBe("select");
      expect(page.freeformDraft).toBe("use syslog");
      expect(state.component.render(100).join("\n")).toMatch(/3\.\s+use syslog/);
      press(state.component, "tab", "enter", "enter"); // answer page 2, submit review
      const result = await execution;
      expect(result.details.answers[0]).toEqual({ question: "First?", kind: "custom", answer: "use syslog" });
   });

   test("a batch multi-select page returns to the list with its draft after tabbing away and back", async () => {
      const tool = await setupTool();
      editorText = "";
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", batch([
         { question: "First?", options: opts2("A", "B"), multiSelect: true },
         { question: "Second?", options: opts2("X", "Y") },
      ]), undefined, undefined, { hasUI: true, ui });
      press(state.component, "down", "down", "enter"); // free-form editor on page 1
      editorText = "use syslog";
      press(state.component, "enter");                 // record on the ticked row
      press(state.component, "tab");                   // away to page 2
      press(state.component, "shift+tab");             // back to page 1
      const page = (state.component as any).pages[0];
      expect(page.mode).toBe("select");
      expect(page.freeformDraft).toBe("use syslog");
      const rendered = state.component.render(100).join("\n");
      expect(rendered).toMatch(/3\.\s+\[✓\]\s+use syslog/);
      press(state.component, "up", "enter");           // confirm page 1 from an option row
      press(state.component, "enter");                 // answer page 2
      press(state.component, "enter");                 // review submit
      const result = await execution;
      expect(result.details.answers[0]).toEqual({ question: "First?", kind: "custom", answer: "use syslog" });
   });

   async function renderMultiList(tool: RegisteredTool, options: any[], width: number, keys: string[] = []) {
      let rendered = "";
      await tool.execute("id", oneQuestion({ question: "Pick?", options, multiSelect: true }), undefined, undefined, {
         hasUI: true,
         ui: {
            custom: async (factory: any) => {
               const component = factory(
                  { requestRender() { }, terminal: { rows: 24 } },
                  createTheme(),
                  createKeybindings(),
                  () => { },
               );
               for (const key of keys) component.handleInput(key);
               rendered = (component as any).pages[0].multiSelectList.render(width).join("\n");
               return null;
            },
         },
      });
      return rendered;
   }

   test("wide multi-select shows a details pane like single-select", async () => {
      const tool = await setupTool();
      const rendered = await renderMultiList(tool, [
         opt("Alpha", "The alpha option keeps the rollout conservative.", "A longer preview body for Alpha."),
         opt("Beta", "The beta option favors faster iteration."),
      ], 120);
      expect(rendered).toContain("## Alpha");
      expect(rendered).toContain("A longer preview body for Alpha.");
      // The left column hides descriptions in the split pane.
      expect(rendered).not.toContain("The alpha option keeps");
   });

   test("the multi-select details pane follows the focused option", async () => {
      const tool = await setupTool();
      const rendered = await renderMultiList(tool, [
         opt("Alpha", "Alpha detail."),
         opt("Beta", "Beta detail."),
      ], 120, ["down"]);
      expect(rendered).toContain("## Beta");
      expect(rendered).toContain("Beta detail.");
      expect(rendered).not.toContain("## Alpha");
   });

   test("the multi-select details pane shows the custom response preview on the free-form row", async () => {
      const tool = await setupTool();
      const rendered = await renderMultiList(tool, opts2(), 120, ["down", "down"]);
      expect(rendered).toContain("Custom response");
      expect(rendered).toContain("Open the editor to write **any** answer.");
   });

   test("narrow multi-select falls back to the single column with descriptions", async () => {
      const tool = await setupTool();
      const rendered = await renderMultiList(tool, [
         opt("Alpha", "The alpha option keeps the rollout conservative."),
         opt("Beta", "The beta option favors faster iteration."),
      ], 60);
      expect(rendered).toContain("The alpha option keeps the rollout conservative.");
      expect(rendered).not.toContain("## Alpha");
   });

   test("singleSelectLayout list keeps wide multi-select in one column", async () => {
      const tool = await setupTool({ singleSelectLayout: "list" });
      const rendered = await renderMultiList(tool, [
         opt("Alpha", "The alpha option stays below its title."),
         opt("Beta", "The beta option stays below its title."),
      ], 120);
      expect(rendered).toContain("The alpha option stays below its title.");
      expect(rendered).not.toContain("## Alpha");
   });
});

// ==========================================================================
// RPC/headless fallback (custom() returns undefined)
// ==========================================================================

describe("RPC fallback", () => {
   test("single-select falls back to ctx.ui.select() with the free-form sentinel", async () => {
      const tool = await setupTool();
      let selectTitle = "";
      let selectOptions: string[] = [];
      const result = await tool.execute("id", oneQuestion({ question: "Pick a color", options: [opt("Red"), opt("Blue")] }), undefined, undefined, {
         hasUI: true,
         ui: {
            custom: async () => undefined,
            select: async (title: string, opts: string[]) => { selectTitle = title; selectOptions = opts; return "Blue"; },
            input: async () => undefined,
         },
      });
      expect(result.details.answers).toEqual([{ question: "Pick a color", kind: "option", answer: "Blue" }]);
      expect(selectTitle).toContain("Pick a color");
      expect(selectOptions.slice(0, 2)).toEqual(["Red", "Blue"]);
      expect(selectOptions[2]).toContain("Type custom response");
   });

   test("selecting the free-form sentinel follows up with input()", async () => {
      const tool = await setupTool();
      let inputCalled = false;
      const sentinel = "✏️ Type custom response...";
      const result = await tool.execute("id", oneQuestion({ options: [opt("Red"), opt("Blue")] }), undefined, undefined, {
         hasUI: true,
         ui: {
            custom: async () => undefined,
            select: async () => sentinel,
            input: async () => { inputCalled = true; return "Custom answer"; },
         },
      });
      expect(inputCalled).toBe(true);
      expect(result.details.answers).toEqual([{ question: "Continue?", kind: "custom", answer: "Custom answer" }]);
   });

   test("multi-select degrades to input() listing the options", async () => {
      const tool = await setupTool();
      let inputTitle = "";
      const result = await tool.execute("id", oneQuestion({ question: "Pick", options: [opt("Red"), opt("Blue"), opt("Green")], multiSelect: true }), undefined, undefined, {
         hasUI: true,
         ui: {
            custom: async () => undefined,
            select: async () => undefined,
            input: async (title: string) => { inputTitle = title; return "Red, Green"; },
         },
      });
      expect(result.details.answers).toEqual([{ question: "Pick", kind: "multi", answer: null, selected: ["Red", "Green"] }]);
      expect(inputTitle).toContain("1. Red");
      expect(inputTitle).toContain("select one or more");
   });

   test("returns cancelled when select() resolves undefined", async () => {
      const tool = await setupTool();
      const result = await tool.execute("id", oneQuestion({ options: [opt("Red"), opt("Blue")] }), undefined, undefined, {
         hasUI: true,
         ui: { custom: async () => undefined, select: async () => undefined, input: async () => undefined },
      });
      expect(result.details).toEqual({ answers: [], cancelled: true });
   });

   test("passes the timeout to the dialog stage", async () => {
      const tool = await setupTool({ timeout: 5000 });
      let capturedOpts: any;
      await tool.execute("id", oneQuestion({ options: [opt("Red"), opt("Blue")] }), undefined, undefined, {
         hasUI: true,
         ui: { custom: async () => undefined, select: async (_t: string, _o: string[], opts: any) => { capturedOpts = opts; return "Red"; } },
      });
      expect(capturedOpts.signal).toBeInstanceOf(AbortSignal);
      expect(capturedOpts.timeout).toBeGreaterThan(0);
      expect(capturedOpts.timeout).toBeLessThanOrEqual(5000);
   });
});

// ==========================================================================
// Cancellation and timeout
// ==========================================================================

describe("cancellation and timeout", () => {
   test("abort cancels a pending RPC dialog without another dialog", async () => {
      const tool = await setupTool({ timeout: 5000 });
      const controller = new AbortController();
      let opened!: () => void;
      const pending = new Promise<void>((resolve) => { opened = resolve; });
      let dismissed = false;
      let calls = 0;
      const execution = tool.execute("id", oneQuestion({ options: [opt("A"), opt("B")] }), controller.signal, undefined, {
         hasUI: true,
         ui: {
            custom: async () => undefined,
            select: async (_t: string, _o: string[], opts: any) => {
               calls++;
               opened();
               return await new Promise<string | undefined>((resolve) => {
                  opts?.signal?.addEventListener("abort", () => { dismissed = true; resolve(undefined); }, { once: true });
               });
            },
         },
      });
      await pending;
      const callsBefore = calls;
      controller.abort();
      const result = await execution;
      expect(dismissed).toBe(true);
      expect(calls).toBe(callsBefore);
      expect(result.details).toEqual({ answers: [], cancelled: true });
   });

   test("abort after the first RPC answer prevents a follow-up dialog", async () => {
      const tool = await setupTool();
      const controller = new AbortController();
      let calls = 0;
      const result = await tool.execute("id", oneQuestion({ options: [opt("A"), opt("B")] }), controller.signal, undefined, {
         hasUI: true,
         ui: {
            custom: async () => undefined,
            select: async (_t: string, options: string[]) => { calls++; controller.abort(); return options[options.length - 1]; },
            input: async () => { calls++; return "A"; },
         },
      });
      expect(calls).toBe(1);
      expect(result.details).toEqual({ answers: [], cancelled: true });
   });

   test("abort while custom UI is unavailable prevents opening an RPC dialog", async () => {
      const tool = await setupTool();
      const controller = new AbortController();
      let dialogs = 0;
      const result = await tool.execute("id", oneQuestion({ options: [opt("A"), opt("B")] }), controller.signal, undefined, {
         hasUI: true,
         ui: {
            custom: async () => { controller.abort(); return undefined; },
            select: async () => { dialogs++; return "A"; },
         },
      });
      expect(dialogs).toBe(0);
      expect(result.details).toEqual({ answers: [], cancelled: true });
   });

   test("the timeout cancels an open prompt", async () => {
      const tool = await setupTool({ timeout: 1 });
      const { state, ui } = mountPrompt();
      const result = await tool.execute("id", oneQuestion(), undefined, undefined, { hasUI: true, ui });
      expect(state.settled).toBe(true);
      expect(result.details).toEqual({ answers: [], cancelled: true });
   });

   test("a late answer after timeout is rejected", async () => {
      const tool = await setupTool({ timeout: 1 });
      const { state, ui } = mountPrompt();
      const result = await tool.execute("id", oneQuestion({ options: opts2("Red", "Blue") }), undefined, undefined, { hasUI: true, ui });
      press(state.component, "enter"); // too late, already cancelled
      expect(result.details).toEqual({ answers: [], cancelled: true });
   });
});

// ==========================================================================
// Multi-question batch
// ==========================================================================

describe("multi-question batch", () => {
   test("records each answer and only the review page submits", async () => {
      const tool = await setupTool();
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", batch([
         { question: "First?", options: opts2("A", "B") },
         { question: "Second?", options: opts2("X", "Y") },
      ]), undefined, undefined, { hasUI: true, ui });

      press(state.component, "enter"); // answer question 1, advance to 2
      expect(state.settled).toBe(false);
      press(state.component, "down", "enter"); // answer question 2 with "Y", advance to review
      expect(state.settled).toBe(false);
      expect(state.component.render(120).join("\n")).toContain("Review answers");
      press(state.component, "enter"); // submit from the review page

      const result = await execution;
      expect(state.settled).toBe(true);
      expect(result.details).toEqual({
         answers: [
            { question: "First?", kind: "option", answer: "A" },
            { question: "Second?", kind: "option", answer: "Y" },
         ],
         cancelled: false,
      });
   });

   test("a single question submits directly without a review page", async () => {
      const tool = await setupTool();
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", oneQuestion({ question: "Only?", options: opts2("A", "B") }), undefined, undefined, { hasUI: true, ui });
      expect(state.component.render(120).join("\n")).not.toContain("Review answers");
      press(state.component, "enter");
      const result = await execution;
      expect(result.details.answers).toEqual([{ question: "Only?", kind: "option", answer: "A" }]);
   });

   test("leaving a page in the free-form editor returns it to the list with the draft on the row", async () => {
      const tool = await setupTool();
      editorText = "";
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", batch([
         { question: "First?", options: opts2("A", "B") },
         { question: "Second?", options: opts2("X", "Y") },
      ]), undefined, undefined, { hasUI: true, ui });
      // Open page 1's free-form editor and type a draft.
      press(state.component, "down", "down", "enter");
      editorText = "custom note";
      // Switch away and back: the page must come back as the option list,
      // not the editor, with the draft shown on its numbered free-form row.
      press(state.component, "tab");
      press(state.component, "shift+tab");
      const page = (state.component as any).pages[0];
      expect(page.mode).toBe("select");
      expect(page.freeformDraft).toBe("custom note");
      const rendered = state.component.render(100).join("\n");
      expect(rendered).toMatch(/3\.\s+custom note/);
      expect(rendered).not.toContain("Type something.");
      // The draft still submits as a custom answer.
      press(state.component, "enter", "enter"); // reopen editor, submit draft
      press(state.component, "enter");          // answer page 2
      press(state.component, "enter");          // review submit
      const result = await execution;
      expect(result.details.answers[0]).toEqual({ question: "First?", kind: "custom", answer: "custom note" });
   });

   test("tab moves between pages and each page keeps its own option selection", async () => {
      const tool = await setupTool();
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", batch([
         { question: "First?", options: opts2("A", "B") },
         { question: "Second?", options: opts2("X", "Y") },
      ]), undefined, undefined, { hasUI: true, ui });
      // Move page 1's selection to "B", then cycle page 1 -> page 2 -> review -> page 1.
      press(state.component, "down");
      press(state.component, "tab", "tab", "tab");
      // Page 1 must still be on "B"; confirming answers "B" and advances to page 2,
      // whose own selection was never touched, so it answers "X".
      press(state.component, "enter");
      press(state.component, "enter");
      press(state.component, "enter"); // review submit
      const result = await execution;
      expect(result.details.answers).toEqual([
         { question: "First?", kind: "option", answer: "B" },
         { question: "Second?", kind: "option", answer: "X" },
      ]);
   });

   test("submitting with an unanswered question needs a second confirmation and drops the skip", async () => {
      const tool = await setupTool();
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", batch([
         { question: "First?", options: opts2("A", "B") },
         { question: "Second?", options: opts2("X", "Y") },
      ]), undefined, undefined, { hasUI: true, ui });
      press(state.component, "enter");   // answer question 1
      press(state.component, "tab");     // jump to the review page, leaving 2 unanswered
      press(state.component, "enter");   // first press warns about the skip
      expect(state.settled).toBe(false);
      expect(state.component.render(120).join("\n")).toContain("unanswered");
      press(state.component, "enter");   // second press submits
      const result = await execution;
      expect(state.settled).toBe(true);
      expect(result.details.answers).toEqual([{ question: "First?", kind: "option", answer: "A" }]);
   });

   test("re-answering a question from the review page replaces its earlier answer", async () => {
      const tool = await setupTool();
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", batch([
         { question: "First?", options: opts2("A", "B") },
         { question: "Second?", options: opts2("X", "Y") },
      ]), undefined, undefined, { hasUI: true, ui });
      press(state.component, "enter", "enter"); // answer 1="A", 2="X", land on review
      press(state.component, "1");              // jump back to question 1
      press(state.component, "down", "enter");  // re-answer 1="B"
      press(state.component, "enter");          // submit
      const result = await execution;
      expect(result.details.answers).toEqual([
         { question: "First?", kind: "option", answer: "B" },
         { question: "Second?", kind: "option", answer: "X" },
      ]);
   });

   test("escape on a page cancels the whole batch", async () => {
      const tool = await setupTool();
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", batch([
         { question: "First?", options: opts2() },
         { question: "Second?", options: opts2() },
      ]), undefined, undefined, { hasUI: true, ui });
      press(state.component, "escape");
      const result = await execution;
      expect(result.details).toEqual({ answers: [], cancelled: true });
   });

   test("escape on the review page cancels the whole batch", async () => {
      const tool = await setupTool();
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", batch([
         { question: "First?", options: opts2("A", "B") },
         { question: "Second?", options: opts2("X", "Y") },
      ]), undefined, undefined, { hasUI: true, ui });
      press(state.component, "enter", "enter"); // both answered, on review
      press(state.component, "escape");
      const result = await execution;
      expect(result.details).toEqual({ answers: [], cancelled: true });
   });

   test("the batch falls back to sequential RPC dialogs", async () => {
      const tool = await setupTool();
      const selects: string[] = [];
      const result = await tool.execute("id", batch([
         { question: "First?", options: opts2("A", "B") },
         { question: "Second?", options: opts2("X", "Y") },
      ]), undefined, undefined, {
         hasUI: true,
         ui: {
            custom: async () => undefined,
            select: async (title: string, choices: string[]) => { selects.push(title); return choices[0]; },
         },
      });
      expect(result.details.answers).toEqual([
         { question: "First?", kind: "option", answer: "A" },
         { question: "Second?", kind: "option", answer: "X" },
      ]);
      expect(selects[0]).toContain("(1/2) First?");
      expect(selects[1]).toContain("(2/2) Second?");
   });

   test("the batch title shows the current header plus page progress", async () => {
      const tool = await setupTool();
      const { state, ui } = mountPrompt();
      const execution = tool.execute("id", batch([
         { question: "First?", header: "Storage", options: opts2() },
         { question: "Second?", header: "Deploy", options: opts2() },
      ]), undefined, undefined, { hasUI: true, ui });
      const first = state.component.render(120).join("\n");
      expect(first).toContain("Storage [1] 2 · review");
      expect(first).not.toContain("ask_user_question");
      press(state.component, "tab");
      expect(state.component.render(120).join("\n")).toContain("Deploy 1 [2] · review");
      press(state.component, "tab");
      // The review page belongs to no single question, so it shows the strip only.
      expect(state.component.render(120).join("\n")).toContain("1 2 · [review]");
      press(state.component, "escape");
      await execution;
   });
});

// ==========================================================================
// TypeBox shim compatibility (exported StringEnum helper)
// ==========================================================================

describe("issue #38 typebox shim compatibility", () => {
   // Fakes stand in for the real builders; their signatures are narrower than
   // TypeBox's generics, so the cast is the only way to hand them to StringEnum.
   const realTypeBoxLike = {
      Unsafe: (schema: Record<string, unknown>) => ({ ...schema }),
      Optional: (schema: unknown) => schema,
      Union: () => {
         throw new Error("union path must not run on real TypeBox");
      },
      Literal: (value: unknown) => value,
   } as unknown as StringEnumBuilder;

   type RuntimeSchema = {
      runtime: true;
      members: unknown[];
      meta: Record<string, unknown>;
      or: () => RuntimeSchema;
      describe: (text: string) => RuntimeSchema;
      default: (value: unknown) => RuntimeSchema;
   };
   const runtimeSchema = (members: unknown[], meta: Record<string, unknown> = {}): RuntimeSchema => ({
      runtime: true,
      members,
      meta,
      or: () => runtimeSchema(members, meta),
      describe: (text) => runtimeSchema(members, { ...meta, description: text }),
      default: (value) => runtimeSchema(members, { ...meta, default: value }),
   });
   const isRuntimeSchema = (value: unknown): value is RuntimeSchema =>
      typeof value === "object" && value !== null && "or" in value && typeof value.or === "function";
   // Mirrors oh-my-pi's legacy-typebox shim: Unsafe yields a plain object,
   // Optional evaluates `asRuntime(schema).or(...)`, Union ignores options.
   const ompOptional = (schema: unknown) => {
      if (!isRuntimeSchema(schema)) throw new TypeError("asRuntime(schema).or is not a function");
      return schema.or();
   };
   const ompLike = {
      Unsafe: (schema: Record<string, unknown>) => ({ ...schema }),
      Optional: ompOptional,
      Union: (members: unknown[]) => runtimeSchema(members),
      Literal: (value: unknown) => ({ literal: value }),
   } as unknown as StringEnumBuilder;

   test("emits the flat enum on hosts whose Type.Optional accepts Type.Unsafe", async () => {
      const { StringEnum } = await import("./index");
      const schema: unknown = StringEnum(["overlay", "inline"] as const, { description: "mode", default: "overlay" }, realTypeBoxLike);
      expect(schema).toEqual({ type: "string", enum: ["overlay", "inline"], description: "mode", default: "overlay" });
   });

   test("falls back to a literal union that Type.Optional can wrap on omp-style shims", async () => {
      const { StringEnum } = await import("./index");
      const schema: unknown = StringEnum(["overlay", "inline"] as const, { description: "mode" }, ompLike);
      if (!isRuntimeSchema(schema)) throw new Error("expected a runtime union schema");
      expect(schema.members).toEqual([{ literal: "overlay" }, { literal: "inline" }]);
      expect(schema.meta).toEqual({ description: "mode" });
      expect(() => ompOptional(schema)).not.toThrow();
   });
});

// ==========================================================================
// Layout: split-pane details, list fallback, preview
// ==========================================================================

describe("single-select layout", () => {
   async function renderList(tool: RegisteredTool, options: any[], width: number, keys: string[] = []) {
      let rendered = "";
      await tool.execute("id", oneQuestion({ options }), undefined, undefined, {
         hasUI: true,
         ui: {
            custom: async (factory: any) => {
               const component = factory(
                  { requestRender() { }, terminal: { rows: 24 } },
                  createTheme(),
                  createKeybindings(),
                  () => { },
               );
               for (const key of keys) component.handleInput(key);
               rendered = (component as any).pages[0].singleSelectList.render(width).join("\n");
               return null;
            },
         },
      });
      return rendered;
   }

   test("renders a details pane for wide single-select layouts", async () => {
      const tool = await setupTool();
      const rendered = await renderList(tool, [
         opt("Alpha", "The alpha option keeps the rollout conservative."),
         opt("Beta", "The beta option favors faster iteration."),
      ], 120);
      expect(rendered).toContain("## Alpha");
      expect(rendered).toContain("The alpha option keeps the rollout conservative.");
   });

   test("prefers the option preview over its description in the details pane", async () => {
      const tool = await setupTool();
      const rendered = await renderList(tool, [
         opt("Alpha", "Short description.", "A much longer preview body for Alpha."),
         opt("Beta", "Beta description."),
      ], 120);
      expect(rendered).toContain("A much longer preview body for Alpha.");
      expect(rendered).not.toContain("Short description.");
   });

   test("keeps wide single-select prompts in one column when the layout is list", async () => {
      const tool = await setupTool({ singleSelectLayout: "list" });
      const rendered = await renderList(tool, [
         opt("Alpha", "The alpha option stays below its title."),
         opt("Beta", "The beta option stays below its title."),
      ], 120);
      expect(rendered).toContain("The alpha option stays below its title.");
      expect(rendered).not.toContain("## Alpha");
   });

   test("falls back to the single-column list on narrow widths", async () => {
      const tool = await setupTool();
      const rendered = await renderList(tool, [
         opt("Alpha", "The alpha option keeps the rollout conservative."),
         opt("Beta", "The beta option favors faster iteration."),
      ], 60);
      expect(rendered).toContain("Alpha");
      expect(rendered).not.toContain("## Alpha");
   });

   test("shows a custom response preview on the free-form row", async () => {
      const tool = await setupTool();
      const rendered = await renderList(tool, opts2(), 120, ["down", "down"]);
      expect(rendered).toContain("Custom response");
      expect(rendered).toContain("Open the editor to write **any** answer.");
   });

   test("PI_ASK_USER_SINGLE_SELECT_LAYOUT applies unless saved configuration overrides it", async () => {
      stubEnv("PI_ASK_USER_SINGLE_SELECT_LAYOUT", "list");
      const fromEnv = await setupTool();
      expect(await renderList(fromEnv, [opt("Alpha", "Below the title."), opt("Beta", "Second.")], 120)).not.toContain("## Alpha");

      const overridden = await setupTool({ singleSelectLayout: "auto" });
      expect(await renderList(overridden, [opt("Alpha", "Below the title."), opt("Beta", "Second.")], 120)).toContain("## Alpha");
   });
});

// ==========================================================================
// Rendering under constrained viewports
// ==========================================================================

describe("constrained viewports", () => {
   test("scrolls a constrained multi-select overlay to the free-form row", async () => {
      const tool = await setupTool({ displayMode: "overlay" });
      let initialRendered: string[] = [];
      let lastOptionRendered: string[] = [];
      let freeformRendered: string[] = [];
      await tool.execute("id", oneQuestion({
         question: "Which option should we use?",
         header: "Rollout",
         // Empty descriptions keep one row per item so the scroll cap engages.
         options: [opt("Option 1", ""), opt("Option 2", ""), opt("Option 3", ""), opt("Option 4", "")],
         multiSelect: true,
      }), undefined, undefined, {
         hasUI: true,
         ui: {
            custom: async (factory: any) => {
               const component = factory(
                  { requestRender() { }, terminal: { rows: 10 } },
                  createTheme(), createKeybindings(), () => { },
               );
               initialRendered = component.render(50);
               for (let index = 0; index < 3; index += 1) component.handleInput("down");
               lastOptionRendered = component.render(50);
               component.handleInput("down");
               freeformRendered = component.render(50);
               return null;
            },
         },
      });
      expect(initialRendered.join("\n")).toContain("Rollout");
      expect(initialRendered.join("\n")).toContain("(1/5)");
      expect(lastOptionRendered.join("\n")).toContain("Option 4");
      expect(lastOptionRendered.join("\n")).toContain("(4/5)");
      expect(freeformRendered.join("\n")).toContain("Type something.");
      expect(freeformRendered.join("\n")).toContain("(5/5)");
      expect(freeformRendered.join("\n")).not.toContain("…");
   });

   test("keeps the editor visible in a constrained overlay", async () => {
      const tool = await setupTool({ displayMode: "overlay" });
      editorText = "A fairly long custom answer that should stay visible.";
      let rendered: string[] = [];
      await tool.execute("id", oneQuestion({ options: opts2() }), undefined, undefined, {
         hasUI: true,
         ui: {
            custom: async (factory: any) => {
               const component = factory(
                  { requestRender() { }, terminal: { rows: 12 } },
                  createTheme(), createKeybindings(), () => { },
               );
               press(component, "down", "down", "enter");
               rendered = component.render(50);
               return null;
            },
         },
      });
      expect(rendered.join("\n")).toContain("Custom response");
   });

   test("does not apply overlay viewport clipping in inline mode", async () => {
      const tool = await setupTool({ displayMode: "inline" });
      let rendered: string[] = [];
      await tool.execute("id", oneQuestion({
         question: "Which option should we use?",
         options: [opt("Option 1"), opt("Option 2"), opt("Option 3"), opt("Option 4")],
         multiSelect: true,
      }), undefined, undefined, {
         hasUI: true,
         ui: {
            custom: async (factory: any) => {
               const component = factory(
                  { requestRender() { }, terminal: { rows: 8 } },
                  createTheme(), createKeybindings(), () => { },
               );
               rendered = component.render(60);
               return null;
            },
         },
      });
      const joined = rendered.join("\n");
      expect(joined).toContain("Option 1");
      expect(joined).toContain("Option 4");
   });

   test("does not crash when the host theme singleton is uninitialised (regression for #17)", async () => {
      // The mocked getMarkdownTheme returns closures that throw on every read,
      // mirroring a host whose theme singleton was never initialised. Rendering
      // must stay quiet instead of crashing mid-render.
      const tool = await setupTool();
      let constructionError: unknown;
      let renderError: unknown;
      try {
         await tool.execute("id", oneQuestion({ options: [opt("Alpha", "desc a"), opt("Beta", "desc b")] }), undefined, undefined, {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(), createKeybindings(), () => { },
                  );
                  try {
                     (component as any).pages[0].singleSelectList.render(120);
                  } catch (error) {
                     renderError = error;
                  }
                  return null;
               },
            },
         });
      } catch (error) {
         constructionError = error;
      }
      expect(constructionError).toBeUndefined();
      expect(renderError).toBeUndefined();
   });
});

// ==========================================================================
// Documented examples match the registered schema
// ==========================================================================

describe("documented examples", () => {
   for (const file of ["README.md"]) {
      test(`${file} examples all match the registered schema`, async () => {
         const tool = await setupTool();
         const schema = tool.parameters;
         const examples = [...readFileSync(file, "utf8").matchAll(/^```json[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)];
         expect(examples.length).toBeGreaterThan(0);
         for (const example of examples) {
            const args = JSON.parse(example[1]!);
            expect(Array.isArray(args.questions)).toBe(true);
            expect(args.questions.length).toBeGreaterThanOrEqual(schema.properties.questions.minItems);
            expect(args.questions.length).toBeLessThanOrEqual(schema.properties.questions.maxItems);
            for (const key of Object.keys(args)) expect(Object.hasOwn(schema.properties, key)).toBe(true);
            for (const entry of args.questions) {
               for (const key of Object.keys(entry)) {
                  expect(Object.hasOwn(schema.properties.questions.items.properties, key)).toBe(true);
               }
               expect(typeof entry.question).toBe("string");
               expect(entry.question.trim().length).toBeGreaterThan(0);
               expect(typeof entry.header).toBe("string");
               expect(Array.isArray(entry.options)).toBe(true);
               expect(entry.options.length).toBeGreaterThanOrEqual(2);
               expect(entry.options.length).toBeLessThanOrEqual(4);
               const labels = entry.options.map((option: any) => {
                  expect(typeof option.label).toBe("string");
                  expect(typeof option.description).toBe("string");
                  return option.label;
               });
               expect(new Set(labels).size).toBe(labels.length);
            }
         }
      });
   }
});
