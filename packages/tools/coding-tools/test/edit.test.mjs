import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createEditTool, createReadTool, createToolChangePreview } from "../dist/index.js";
import { atomicWriteText } from "../dist/atomic-write.js";
import { assertErrorCode, createWorkspace, executeTool } from "./helpers.mjs";

test("edit replaces one exact occurrence", async (t) => {
  const cwd = await createWorkspace(t);
  await writeFile(join(cwd, "file.txt"), "before value after");

  const result = await executeTool(createEditTool({ cwd }), {
    path: "file.txt",
    oldText: "value",
    newText: "updated",
  });

  assert.deepEqual(result, { path: "file.txt", replacements: 1 });
  assert.equal(
    await readFile(join(cwd, "file.txt"), "utf8"),
    "before updated after",
  );
});

test("read/edit preserves CRLF and literal dollar sequences; aborted staging preserves the destination", async (t) => {
  const cwd = await createWorkspace(t);
  const path = join(cwd, "script.txt");
  await writeFile(path, "one\r\ntwo\r\n");
  const { content } = await executeTool(createReadTool({ cwd }), { path: "script.txt" });
  const replacement = "$$ $& $` $' $1\r\n";
  const preview = await createToolChangePreview(cwd, "edit", { path: "script.txt", oldText: content, newText: replacement });
  assert.equal(preview.status, "ready");
  assert.ok(preview.diff.includes("$$ $& $` $' $1"));
  await executeTool(createEditTool({ cwd }), { path: "script.txt", oldText: content, newText: replacement });
  assert.equal(await readFile(path, "utf8"), replacement);
  const controller = new AbortController();
  const writing = atomicWriteText(path, "x".repeat(16 * 1024 * 1024), controller.signal);
  setImmediate(() => controller.abort());
  await assert.rejects(writing);
  assert.equal(await readFile(path, "utf8"), replacement);
});

test("edit preserves a UTF-8 byte order mark", async (t) => {
  const cwd = await createWorkspace(t);
  const path = join(cwd, "bom.txt");
  await writeFile(path, Buffer.from([0xef, 0xbb, 0xbf, 0x61]));

  await executeTool(createEditTool({ cwd }), {
    path: "bom.txt",
    oldText: "a",
    newText: "b",
  });

  assert.deepEqual(await readFile(path), Buffer.from([0xef, 0xbb, 0xbf, 0x62]));
});

test("edit rejects missing and ambiguous matches without changing the file", async (t) => {
  const cwd = await createWorkspace(t);
  const path = join(cwd, "file.txt");
  await writeFile(path, "aaa");
  const tool = createEditTool({ cwd });

  await assert.rejects(
    executeTool(tool, { path: "file.txt", oldText: "missing", newText: "x" }),
    assertErrorCode("CODING_TOOL_EDIT_NOT_FOUND"),
  );
  await assert.rejects(
    executeTool(tool, { path: "file.txt", oldText: "aa", newText: "x" }),
    assertErrorCode("CODING_TOOL_EDIT_AMBIGUOUS"),
  );
  assert.equal(await readFile(path, "utf8"), "aaa");
});

test("edit enforces the resulting file byte limit", async (t) => {
  const cwd = await createWorkspace(t);
  const path = join(cwd, "file.txt");
  await writeFile(path, "a");

  await assert.rejects(
    executeTool(createEditTool({ cwd, maxBytes: 3 }), {
      path: "file.txt",
      oldText: "a",
      newText: "1234",
    }),
    assertErrorCode("CODING_TOOL_FILE_TOO_LARGE"),
  );
  assert.equal(await readFile(path, "utf8"), "a");
});
