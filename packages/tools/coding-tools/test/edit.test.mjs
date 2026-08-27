import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createEditTool } from "../dist/index.js";
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

test("edit allows deleting the matched text", async (t) => {
  const cwd = await createWorkspace(t);
  await writeFile(join(cwd, "file.txt"), "remove me");

  await executeTool(createEditTool({ cwd }), {
    path: "file.txt",
    oldText: "remove ",
    newText: "",
  });

  assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "me");
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
