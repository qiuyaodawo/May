import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { createCodingTool, atomicWriteText, createTextChangePreview } from "../dist/index.js";
import { executeTool } from "./helpers.mjs";

test("file feedback validates written JSON inside record and returns diagnostics after the lock", async (t) => {
  const base = resolve(".test-output", "file-feedback");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(join(base, "workspace-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let locked = false;
  const guard = async (operation) => {
    assert.equal(locked, false);
    locked = true;
    try {
      return await operation.run();
    } finally {
      locked = false;
    }
  };
  const recorded = [];
  // A host feedback provider using the native JSON parser, independent of LSP.
  const fileFeedback = {
    record(path, content) {
      assert.equal(locked, true);
      recorded.push(content);
      let items = [];
      try {
        JSON.parse(content);
      } catch (error) {
        items = [
          {
            line: 1,
            column: 1,
            endLine: 1,
            endColumn: 2,
            severity: "error",
            message: error.message,
            source: "JSON.parse",
          },
        ];
      }
      return {
        async result(signal) {
          assert.equal(locked, false);
          signal.throwIfAborted();
          assert.equal(await readFile(path.absolute, "utf8"), content);
          return { diagnostics: { status: "complete", items, truncated: false } };
        },
      };
    },
  };
  const write = createCodingTool("write", { cwd, guard, fileFeedback });
  const invalid = await executeTool(write, { path: "data.json", content: "{" });
  assert.equal(invalid.diagnostics.status, "complete");
  assert.equal(invalid.diagnostics.items[0].severity, "error");
  const edit = createCodingTool("edit", { cwd, guard, fileFeedback });
  const valid = await executeTool(edit, { path: "data.json", oldText: "{", newText: "{}" });
  assert.deepEqual(valid.diagnostics.items, []);
  assert.deepEqual(recorded, ["{", "{}"]);
  await assert.rejects(executeTool(edit, { path: "data.json", oldText: "missing", newText: "value" }), {
    code: "CODING_TOOL_EDIT_NOT_FOUND",
  });
  assert.deepEqual(recorded, ["{", "{}"]);
  const unsupported = createCodingTool("write", { cwd, fileFeedback: { record: () => undefined } });
  assert.equal("diagnostics" in (await executeTool(unsupported, { path: "other.txt", content: "text" })), false);
});

test("public atomic writer and text preview operate on the same text", async (t) => {
  const base = resolve(".test-output", "text-preview");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(join(base, "workspace-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const original = "const name = 1;\n";
  const updated = "const renamed = 1;\n";
  await atomicWriteText(join(cwd, "file.ts"), updated, new AbortController().signal);
  const preview = createTextChangePreview("edit", "file.ts", original, updated);
  assert.equal(preview.status, "ready");
  assert.equal(preview.additions, 1);
  assert.equal(preview.deletions, 1);
  assert.match(preview.diff, /\+const renamed = 1;/u);
  assert.equal(await readFile(join(cwd, "file.ts"), "utf8"), updated);
});
