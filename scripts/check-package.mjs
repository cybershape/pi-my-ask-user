import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// npm <= 11 prints an array of packed tarballs; npm >= 12 (npm/cli#9247) prints
// an object keyed by package name. publish.yml installs npm@latest for trusted
// publishing, so the major version drifts on its own: accept both shapes.
const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  encoding: "utf8",
}));
const tarball = Array.isArray(packed)
  ? packed[0]
  : packed && typeof packed === "object" && !Array.isArray(packed.files)
    ? Object.values(packed)[0]
    : packed;
if (!tarball || !Array.isArray(tarball.files)) {
  console.error(`Unrecognised npm pack output: ${JSON.stringify(packed).slice(0, 300)}`);
  process.exit(1);
}
const expectedFiles = [
  "LICENSE",
  "README.md",
  "ask-user-settings.ts",
  "index.ts",
  "package.json",
  "single-select-layout.ts",
  "skills/ask-before-acting/SKILL.md",
];
assert.deepEqual(tarball.files.map(({ path }) => path).sort(), expectedFiles.sort());
console.log(`Package contents verified: ${tarball.files.length} files (${tarball.size} bytes packed)`);
