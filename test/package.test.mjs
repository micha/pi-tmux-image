import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

test("declares its Pi extension explicitly", () => {
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.deepEqual(manifest.pi.extensions, ["./extensions/index.ts"]);
  for (const file of manifest.pi.extensions) assert.ok(existsSync(new URL(file, root)));
});

test("uses host-provided Pi modules only as peer dependencies", () => {
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
    assert.equal(manifest.peerDependencies[name], "*");
    assert.ok(!manifest.dependencies?.[name]);
  }
});

test("separates human and robot documentation", () => {
  assert.ok(existsSync(new URL("README.md", root)));
  assert.ok(existsSync(new URL("AGENTS.md", root)));
});

test("contains no machine-specific Nix-store executable paths or image context filter", () => {
  const extension = readFileSync(new URL("extensions/index.ts", root), "utf8");
  const pdf = readFileSync(new URL("src/pdf.mjs", root), "utf8");
  assert.ok(!extension.includes("/nix/store/"));
  assert.ok(!pdf.includes("/nix/store/"));
  assert.ok(!extension.includes('pi.on("context"'));
  assert.ok(extension.includes("content: imageResult.content"));
  assert.ok(extension.includes("triggerTurn: false"));
});
