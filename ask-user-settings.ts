import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface AskUserSettings {
   displayMode: "overlay" | "inline";
   singleSelectLayout: "auto" | "list";
   overlayToggleKey: string;
   /** Milliseconds across the whole prompt; zero disables the timeout. */
   timeout: number;
}

export type AskUserConfig = Partial<AskUserSettings>;
export type AskUserSettingKey = keyof AskUserSettings;

export const ASK_USER_DEFAULTS: Readonly<AskUserSettings> = {
   displayMode: "inline",
   singleSelectLayout: "auto",
   overlayToggleKey: "alt+o",
   timeout: 0,
};
export const ASK_USER_SETTING_KEYS = Object.keys(ASK_USER_DEFAULTS) as AskUserSettingKey[];
export const ASK_USER_SETTINGS_FILENAME = "ask-user-settings.json";

const SHORTCUT_DISABLE_VALUES = new Set(["off", "none", "disabled", ""]);

export function normalizeShortcutSpec(value: string | null | undefined): string | null | undefined {
   if (value === undefined) return undefined;
   if (value === null) return null;
   const trimmed = value.trim().toLowerCase();
   return SHORTCUT_DISABLE_VALUES.has(trimmed) ? null : trimmed;
}

export function isValidShortcutSpec(spec: string): boolean {
   // Match the existing shortcut syntax; the host's matchesKey performs matching.
   return !!spec && /^[a-z0-9+_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]+$/i.test(spec)
      && !spec.startsWith("+") && !spec.endsWith("+") && !spec.includes("++");
}

export function validateSetting(key: AskUserSettingKey, value: unknown): void {
   switch (key) {
      case "displayMode":
         if (value === "inline" || value === "overlay") return;
         throw new Error("displayMode must be inline or overlay.");
      case "singleSelectLayout":
         if (value === "auto" || value === "list") return;
         throw new Error("singleSelectLayout must be auto or list.");
      case "timeout":
         if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647) return;
         throw new Error("timeout must be an integer from 0 to 2147483647 milliseconds (0 disables it).");
      default:
         if (typeof value === "string") {
            const spec = normalizeShortcutSpec(value);
            if (spec === null || (spec !== undefined && isValidShortcutSpec(spec))) return;
         }
         throw new Error(`${key} must be a shortcut such as alt+o, or off to disable it.`);
   }
}

/** `default` removes an override so the environment/built-in default applies. */
export function parseSettingValue(key: AskUserSettingKey, text: string): AskUserSettings[AskUserSettingKey] | undefined {
   const input = text.trim();
   if (input.toLowerCase() === "default") return undefined;
   const value = key === "timeout" ? (input ? Number(input) : NaN)
      : input.toLowerCase();
   validateSetting(key, value);
   return value as AskUserSettings[AskUserSettingKey];
}

/** Dedicated file only: never read or modify Pi's shared settings.json. */
export class AskUserSettingsStore {
   constructor(readonly path: string) { }

   private readDocument(): Record<string, unknown> {
      let text: string;
      try {
         text = readFileSync(this.path, "utf8");
      } catch (error) {
         if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
         throw error;
      }
      const document: unknown = JSON.parse(text);
      if (!document || typeof document !== "object" || Array.isArray(document)) {
         throw new Error("Settings must be a JSON object.");
      }
      for (const key of ASK_USER_SETTING_KEYS) {
         if (Object.hasOwn(document, key)) validateSetting(key, (document as Record<string, unknown>)[key]);
      }
      return document as Record<string, unknown>;
   }

   read(): AskUserConfig {
      const document = this.readDocument();
      return Object.fromEntries(ASK_USER_SETTING_KEYS.filter((key) => Object.hasOwn(document, key))
         .map((key) => [key, document[key]])) as AskUserConfig;
   }

   update(key: AskUserSettingKey, value: AskUserSettings[AskUserSettingKey] | undefined): void {
      if (value !== undefined) validateSetting(key, value);
      // Re-read before updating to retain other settings and unknown future fields.
      // Invalid/unreadable files are never silently overwritten.
      const document = this.readDocument();
      if (value === undefined) delete document[key];
      else document[key] = value;
      mkdirSync(dirname(this.path), { recursive: true });
      const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
      try {
         writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx", mode: 0o600 });
         renameSync(temporaryPath, this.path);
      } finally {
         rmSync(temporaryPath, { force: true });
      }
   }
}
