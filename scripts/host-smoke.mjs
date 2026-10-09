import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createEventBus } from "@earendil-works/pi-coding-agent";

// Isolate all settings reads/writes from the real user's Pi configuration.
const agentDir = mkdtempSync(resolve(".ask-user-host-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
const hostEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { loadExtensions } = await import(new URL("./core/extensions/loader.js", hostEntry));
const events = createEventBus();
const loaded = await loadExtensions([resolve("index.ts")], process.cwd(), events);
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, 1);
const tools = loaded.extensions[0].tools;
assert.deepEqual([...tools.keys()], ["ask_user_question"]);
const tool = tools.get("ask_user_question").definition;
assert.equal(tool.name, "ask_user_question");
assert.equal(tool.executionMode, "sequential");
assert.equal(tool.parameters.type, "object");
// Every call uses questions, including a single-question call.
assert.deepEqual(tool.parameters.required, ["questions"]);
assert.equal(tool.parameters.additionalProperties, false);
assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["questions"]);
const settingKeys = ["displayMode", "singleSelectLayout", "overlayToggleKey", "timeout"];
const command = loaded.extensions[0].commands.get("ask-user-question-settings");
assert.ok(command, "settings command must be registered");
const configure = async (key, value) => {
   const errors = [];
   await command.handler(`${key} ${value}`, {
      hasUI: true,
      ui: { notify(message, type) { if (type === "error" || type === "warning") errors.push(message); } },
   });
   assert.deepEqual(errors, []);
};
const batchSchema = tool.parameters.properties.questions;
assert.equal(batchSchema.type, "array");
assert.equal(batchSchema.minItems, 1);
assert.equal(batchSchema.maxItems, 4);
assert.equal(batchSchema.items.type, "object");
assert.deepEqual(batchSchema.items.required.sort(), ["header", "options", "question"]);
const optionList = batchSchema.items.properties.options;
assert.equal(optionList.type, "array");
assert.equal(optionList.minItems, 2);
assert.equal(optionList.maxItems, 4);
assert.equal(optionList.items.type, "object");
assert.deepEqual(optionList.items.required.sort(), ["description", "label"]);
// Union combinators get stripped or rejected by several providers/proxies (Google
// function calling, Codex-style backends, cmux), so the whole schema stays flat (#22).
assert.doesNotMatch(JSON.stringify(tool.parameters), /"(anyOf|oneOf|allOf)"/);
// The unit tests mock TypeBox, so the nested questions schema meets a real validator only here.
const aiPackage = pathToFileURL(findPackageJSON("@earendil-works/pi-ai", hostEntry));
const { validateToolArguments } = await import(new URL("./dist/utils/validation.js", aiPackage));
const validate = (args) => validateToolArguments(tool, { id: "smoke-validate", name: tool.name, arguments: args });
const option = (label, description) => ({ label, description });
const yesNo = (question, header) => ({
   question,
   header,
   options: [option("Yes", "Go ahead"), option("No", "Hold off")],
});
assert.doesNotThrow(() => validate({
   questions: [
      { ...yesNo("Ship it?", "Release"), options: [option("Yes", "Go ahead"), option("No", "Wait for review"), option("Later", "Defer")] },
      { question: "Which wave?", header: "Rollout", options: [option("First", "Now"), option("Second", "Next sprint")], multiSelect: true },
   ],
}));
assert.doesNotThrow(() => validate({ questions: [yesNo("Only one?", "Release")] }));
assert.throws(() => validate({}), "questions is required");
assert.throws(() => validate({ questions: [] }), "questions needs at least 1 entry");
for (const field of ["question", "header", "options", "multiSelect", ...settingKeys]) {
   assert.throws(() => validate({ questions: [yesNo("Only one?", "Release")], [field]: null }), `${field} is no longer accepted at the top level`);
}
assert.throws(() => validate({ question: "Old call?", header: "h", options: [option("A", "a"), option("B", "b")] }), "old single-question calls are rejected");
assert.throws(
   () => validate({
      questions: ["A?", "B?", "C?", "D?", "E?"].map((question) => ({ question, header: question, options: [option("Y", "y"), option("N", "n")] })),
   }),
   "questions accepts at most 4 entries",
);
assert.throws(
   () => validate({ questions: [{ question: "Too few?", header: "h", options: [option("Y", "y")] }] }),
   "options needs at least 2 entries",
);
assert.throws(
   () => validate({ questions: [{ question: "No header?", options: [option("Y", "y"), option("N", "n")] }] }),
   "header is required",
);
assert.throws(
   () => validate({ questions: [{ question: "No description?", header: "h", options: [{ label: "Y" }, { label: "N" }] }] }),
   "option description is required",
);
await configure("displayMode", "inline");
await configure("singleSelectLayout", "auto");
await configure("overlayToggleKey", "alt+o");
await configure("timeout", "0");
assert.deepEqual(JSON.parse(readFileSync(resolve(agentDir, "ask-user-settings.json"), "utf8")), {
   displayMode: "inline", singleSelectLayout: "auto",
   overlayToggleKey: "alt+o", timeout: 0,
});

const blocked = [];
events.on("herdr:blocked", (event) => blocked.push(event.active));
let selected = false;
const rpcResult = await tool.execute("smoke-rpc", {
   questions: [yesNo("Continue?", "Release")],
}, undefined, undefined, {
   hasUI: true,
   ui: {
      custom: async () => undefined,
      select: async (prompt, choices) => {
         assert.match(prompt, /Continue\?/);
         assert.deepEqual(choices.slice(0, 2), ["Yes", "No"]);
         assert.equal(choices.length, 3, "the free-form row is always offered");
         selected = true;
         return "Yes";
      },
   },
});
assert.equal(selected, true);
assert.equal(rpcResult.details.cancelled, false);
assert.deepEqual(rpcResult.details.answers, [
   { question: "Continue?", kind: "option", answer: "Yes" },
]);
assert.deepEqual(blocked, [true, false]);

await assert.rejects(
   tool.execute("smoke-no-ui", { questions: [yesNo("Continue?", "Release")] }, undefined, undefined, { hasUI: false }),
   /requires interactive mode/,
);
await assert.rejects(
   tool.execute("smoke-malformed", {
      questions: [{ question: "Continue?", header: "h", options: [{ label: " " }, { label: "No", description: "no" }] }],
   }, undefined, undefined, { hasUI: true, ui: {} }),
   /questions\[0\]\.options\[0\] must be an object/,
);
await assert.rejects(
   tool.execute("smoke-reserved", {
      questions: [{ question: "Continue?", header: "h", options: [option("Other", "fallback"), option("No", "hold")] }],
   }, undefined, undefined, { hasUI: true, ui: {} }),
   /reserved label "Other"/,
);
await assert.rejects(
   tool.execute("smoke-dup-labels", {
      questions: [{ question: "Continue?", header: "h", options: [option("Yes", "go"), option("Yes", "again")] }],
   }, undefined, undefined, { hasUI: true, ui: {} }),
   /repeats the label "Yes"/,
);
for (const failure of [new Error("UI failed"), "UI failed"]) {
   blocked.length = 0;
   await assert.rejects(
      tool.execute("smoke-ui-error", { questions: [yesNo("Continue?", "Release")] },
         undefined, undefined, {
            hasUI: true,
            ui: { custom: async () => { throw failure; } },
         }),
      { name: "Error", message: "UI failed" },
   );
   assert.deepEqual(blocked, [true, false]);
}

// Use the host's actual theme, TUI components, key parser, and cell-width calculation.
// Only the terminal scheduling surface is inert; no real terminal is opened.
const tuiPackage = pathToFileURL(findPackageJSON("@earendil-works/pi-tui", hostEntry));
const { getKeybindings, visibleWidth } = await import(new URL("./dist/index.js", tuiPackage));
const { initTheme, theme } = await import(new URL("./modes/interactive/theme/theme.js", hostEntry));
initTheme("dark");
const errorLines = tool.renderResult(
   { content: [{ type: "text", text: "UI failed" }], details: undefined },
   { expanded: false, isPartial: false }, theme, { isError: true },
).render(80).join("\n");
assert.ok(errorLines.includes("UI failed"));
assert.ok(!errorLines.includes("Cancelled"));
await configure("singleSelectLayout", "list");
for (const label of ["Alpha", "日本語 😀 café"]) {
   const rendered = await tool.execute("smoke-tui", {
      questions: [{ question: "Choose one", header: "Group", options: [option(label, "first"), option("Beta", "second")] }],
   }, undefined, undefined, {
      hasUI: true,
      ui: {
         custom: async (factory) => {
            let response;
            const component = factory(
               { requestRender() {}, terminal: { rows: 40 } },
               theme, getKeybindings(), (value) => { response = value; },
            );
            for (const width of [40, 80]) {
               component.invalidate();
               const lines = component.render(width);
               assert.ok(lines.length > 0);
               assert.ok(lines.some((line) => line.includes(label)), "Option must remain visible");
               for (const line of lines) {
                  assert.ok(visibleWidth(line) <= width, `Rendered line exceeds ${width} columns`);
               }
            }
            assert.ok(!component.render(80).some((line) => line.includes("Review answers")), "One question must not show review answers");
            component.handleInput("\r");
            assert.deepEqual(response, [{ question: "Choose one", kind: "option", answer: label }]);
            return response;
         },
      },
   });
   assert.deepEqual(rendered.details.answers, [{ question: "Choose one", kind: "option", answer: label }]);
}
// Short reviews: every answer must be reachable by scrolling, within the height
// cap and the width, with real wrapping. Inline matches Pi's fullscreen dock.
const longQuestion = (n) => `Question ${n}: which of these fairly long options should the service use?`;
// At width 40 the answer row "   → " plus this 31-cell label fills the inner width
// exactly, so an overflow marker that costs width would cut off the "Z<n>Q" tail.
const fullWidthAnswer = (n) => `Answer ${n} ${"a".repeat(19)}Z${n}Q`;
for (const { displayMode, width, rows, cap } of [
   { displayMode: "overlay", width: 80, rows: 8, cap: 6 },
   { displayMode: "overlay", width: 40, rows: 7, cap: 5 },
   { displayMode: "inline", width: 40, rows: 12, cap: 7 },
]) {
   await configure("displayMode", displayMode);
   await tool.execute("smoke-batch-short", {
      questions: [1, 2, 3, 4].map((n) => ({
         question: longQuestion(n),
         header: `Q${n}`,
         options: [option(fullWidthAnswer(n), "long first option"), option(`Alt ${n}`, "short second option")],
      })),
   }, undefined, undefined, {
      hasUI: true,
      ui: {
         custom: async (factory) => {
            let response;
            const component = factory(
               { requestRender() {}, terminal: { rows } },
               theme, getKeybindings(), (value) => { response = value; },
            );
            for (let n = 0; n < 4; n++) component.handleInput("\r");
            const seen = new Set();
            for (let step = 0; step < 30; step++) {
               const lines = component.render(width);
               assert.ok(lines.length <= cap, `${displayMode} review exceeds ${cap} rows`);
               assert.ok(lines.some((line) => line.includes("submit")), `${displayMode} review hides its hints`);
               for (const line of lines) {
                  assert.ok(visibleWidth(line) <= width, `${displayMode} review line exceeds ${width} columns`);
                  const answer = line.match(/Z[1-4]Q/);
                  if (answer) seen.add(answer[0]);
               }
               component.handleInput("\x1b[B");
            }
            assert.deepEqual([...seen].sort(), ["Z1Q", "Z2Q", "Z3Q", "Z4Q"], `${displayMode} ${width}x${rows} review hides answer text`);
            component.handleInput("\r");
            return response;
         },
      },
   });
}
// The batch prompt: its pages (strip in the frame title) and review page must fit
// the width with the host's real wrapping, in both display modes.
for (const displayMode of ["inline", "overlay"]) {
   await configure("displayMode", displayMode);
   const batch = await tool.execute("smoke-batch-tui", {
      questions: [
         { question: "Choose one", header: "Group A", options: [option("日本語 😀 café", "unicode"), option("Beta", "second")] },
         { question: "Pick another", header: "Group B", options: [option("Gamma", "third"), option("Delta", "fourth")] },
      ],
   }, undefined, undefined, {
      hasUI: true,
      ui: {
         custom: async (factory) => {
            let response;
            const component = factory(
               { requestRender() {}, terminal: { rows: 16 } },
               theme, getKeybindings(), (value) => { response = value; },
            );
            const assertFits = (step) => {
               for (const width of [40, 80]) {
                  component.invalidate();
                  for (const line of component.render(width)) {
                     assert.ok(visibleWidth(line) <= width, `${displayMode} ${step} line exceeds ${width} columns`);
                  }
               }
            };
            assertFits("page");
            component.handleInput("\r");
            component.handleInput("\r");
            assertFits("review");
            assert.ok(component.render(80).some((line) => line.includes("Review answers")));
            // Kitty's keyboard protocol sends "1" as CSI-u; it must still jump back to question 1.
            component.handleInput("\x1b[49;1u");
            assert.ok(!component.render(80).some((line) => line.includes("Review answers")), "CSI-u digit must open question 1");
            component.handleInput("\r");
            component.handleInput("\r");
            return response;
         },
      },
   });
   assert.deepEqual(batch.details.answers, [
      { question: "Choose one", kind: "option", answer: "日本語 😀 café" },
      { question: "Pick another", kind: "option", answer: "Gamma" },
   ]);
}
console.log("Host smoke passed: registration, schema, batch schema validation, RPC select, thrown errors, error rendering, native TUI, batch TUI.");
