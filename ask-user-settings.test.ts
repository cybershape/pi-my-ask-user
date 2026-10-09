import { describe, expect, onTestFinished, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
   ASK_USER_DEFAULTS,
   ASK_USER_SETTINGS_FILENAME,
   AskUserSettingsStore,
   parseSettingValue,
   type AskUserSettingKey,
} from "./ask-user-settings";

function storeFixture() {
   // Never use the real Pi user directory in tests.
   const directory = mkdtempSync(join(process.cwd(), ".ask-user-store-test-"));
   onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
   const path = join(directory, ASK_USER_SETTINGS_FILENAME);
   return { directory, path, store: new AskUserSettingsStore(path) };
}

describe("ask_user settings persistence", () => {
   test("defaults change only displayMode and a missing file is not created on read", () => {
      expect(ASK_USER_DEFAULTS).toEqual({
         displayMode: "inline", singleSelectLayout: "auto",
         overlayToggleKey: "alt+o", timeout: 0,
      });
      const { path, store } = storeFixture();
      expect(store.read()).toEqual({});
      expect(existsSync(path)).toBe(false);
   });

   test("settings survive new store instances and writes leave no temporary file", () => {
      const { directory, path, store } = storeFixture();
      store.update("displayMode", "overlay");
      new AskUserSettingsStore(path).update("timeout", 5000);
      expect(new AskUserSettingsStore(path).read()).toEqual({ displayMode: "overlay", timeout: 5000 });
      expect(readdirSync(directory)).toEqual([ASK_USER_SETTINGS_FILENAME]);
   });

   test("updates preserve other preferences, unknown fields and shared Pi settings", () => {
      const { directory, path, store } = storeFixture();
      const sharedPath = join(directory, "settings.json");
      const shared = '{"model":"shared-model"}\n';
      writeFileSync(sharedPath, shared);
      writeFileSync(path, JSON.stringify({ singleSelectLayout: "list", futureSetting: { enabled: true } }));
      store.update("overlayToggleKey", "alt+h");
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ singleSelectLayout: "list", futureSetting: { enabled: true }, overlayToggleKey: "alt+h" });
      expect(readFileSync(sharedPath, "utf8")).toBe(shared);
   });

   test("default removes only the chosen override and retains explicit zero and off", () => {
      const { store } = storeFixture();
      store.update("overlayToggleKey", "off");
      store.update("timeout", 0);
      store.update("displayMode", "overlay");
      store.update("displayMode", parseSettingValue("displayMode", "default"));
      expect(store.read()).toEqual({ overlayToggleKey: "off", timeout: 0 });
   });

   for (const document of ["{invalid", "[]", "null", '"text"', '{"displayMode":"fullscreen"}', '{"timeout":-1}', '{"singleSelectLayout":"wide"}']) {
      test(`invalid existing file is reported without being overwritten: ${document}`, () => {
         const { path, store } = storeFixture();
         writeFileSync(path, document);
         expect(() => store.read()).toThrow();
         expect(() => store.update("displayMode", "inline")).toThrow();
         expect(readFileSync(path, "utf8")).toBe(document);
      });
   }

   test("invalid new values do not create a file", () => {
      const { path, store } = storeFixture();
      expect(() => store.update("timeout", -1)).toThrow();
      expect(existsSync(path)).toBe(false);
   });
});

describe("ask_user setting values", () => {
   test("parses choices, booleans, shortcuts, disabled timeout and fallback reset", () => {
      expect(parseSettingValue("displayMode", " OVERLAY ")).toBe("overlay");
      expect(parseSettingValue("singleSelectLayout", "list")).toBe("list");
      expect(parseSettingValue("overlayToggleKey", "ALT+H")).toBe("alt+h");
      expect(parseSettingValue("overlayToggleKey", "off")).toBe("off");
      expect(parseSettingValue("timeout", "0")).toBe(0);
      expect(parseSettingValue("timeout", "5000")).toBe(5000);
      expect(parseSettingValue("displayMode", "default")).toBeUndefined();
   });

   for (const [key, input] of [
      ["displayMode", "fullscreen"], ["singleSelectLayout", "wide"],
      ["overlayToggleKey", "++bad++"], ["overlayToggleKey", "a b"],
      ["timeout", ""], ["timeout", "-1"], ["timeout", "1.5"], ["timeout", "Infinity"], ["timeout", "2147483648"],
   ] as Array<[AskUserSettingKey, string]>) {
      test(`rejects ${key} = ${JSON.stringify(input)}`, () => {
         expect(() => parseSettingValue(key, input)).toThrow();
      });
   }
});
