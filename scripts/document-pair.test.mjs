import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspectDocument, compareStructure } from "./document-pair.mjs";

test("real documentation preserves hashes across Windows line endings", async () => {
  const text = (await readFile(new URL("../docs/en/getting-started.md", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  assert.deepEqual(inspectDocument(text), inspectDocument(text.replaceAll("\n", "\r\n")));
  const changed = inspectDocument(text.replace("# ", "# Updated "));
  assert.notDeepEqual(changed.sections, inspectDocument(text).sections);
});

test("blockquote nesting around an existing page changes its structure", async () => {
  const text = await readFile(new URL("../docs/en/getting-started.md", import.meta.url), "utf8");
  const quoted = text.split("\n").map(line => `> ${line}`).join("\n");
  assert.ok(compareStructure(inspectDocument(text), inspectDocument(quoted)).length > 0);
});

test("CLI accepts Windows paths and refuses unspecified confirmations", () => {
  const script = fileURLToPath(new URL("./check-document-pairs.mjs", import.meta.url));
  const checked = spawnSync(process.execPath, [script, "guides\\custom-tool.md"], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
  const refused = spawnSync(process.execPath, [script, "--write"], { encoding: "utf8" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /requires reviewed document paths/);
});

test("real bilingual pages reject removed structural elements", async () => {
  const [en, zh] = await Promise.all(["en", "zh-CN"].map(locale => readFile(new URL(`../docs/${locale}/getting-started.md`, import.meta.url), "utf8")));
  assert.deepEqual(compareStructure(inspectDocument(en), inspectDocument(zh)), []);
  assert.ok(compareStructure(inspectDocument(en), inspectDocument(zh.replace(/^## /m, "### "))).length > 0);
});
