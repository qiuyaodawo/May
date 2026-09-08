import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createWriteTool } from "../dist/index.js";
import { assertErrorCode, createWorkspace, executeTool } from "./helpers.mjs";

test("write creates parent directories and overwrites files", async (t) => {
  const cwd = await createWorkspace(t);
  const tool = createWriteTool({ cwd });

  const created = await executeTool(tool, {
    path: "src/new.txt",
    content: "first",
  });
  const overwritten = await executeTool(tool, {
    path: "src/new.txt",
    content: "second",
  });

  assert.deepEqual(created, { path: "src/new.txt", bytesWritten: 5 });
  assert.deepEqual(overwritten, { path: "src/new.txt", bytesWritten: 6 });
  assert.equal(await readFile(join(cwd, "src", "new.txt"), "utf8"), "second");
});

test("write enforces its byte limit", async (t) => {
  const cwd = await createWorkspace(t);
  const tool = createWriteTool({ cwd, maxBytes: 3 });

  await assert.rejects(
    executeTool(tool, { path: "file.txt", content: "1234" }),
    assertErrorCode("CODING_TOOL_FILE_TOO_LARGE"),
  );
  await assert.rejects(
    readFile(join(cwd, "file.txt")),
    (error) => error?.code === "ENOENT",
  );
});
