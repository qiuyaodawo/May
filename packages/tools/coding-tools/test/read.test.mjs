import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createReadTool } from "../dist/index.js";
import { assertErrorCode, createWorkspace, executeTool } from "./helpers.mjs";

test("read returns a bounded line range", async (t) => {
  const cwd = await createWorkspace(t);
  await writeFile(join(cwd, "notes.txt"), "one\r\ntwo\r\nthree");
  const tool = createReadTool({ cwd, maxLines: 2 });

  const result = await executeTool(tool, {
    path: "notes.txt",
    offset: 2,
    limit: 2,
  });

  assert.equal(tool.name, "read");
  assert.deepEqual(result, {
    path: "notes.txt",
    content: "two\nthree",
    startLine: 2,
    endLine: 3,
    totalLines: 3,
    truncated: true,
  });
});

test("read handles an empty file", async (t) => {
  const cwd = await createWorkspace(t);
  await writeFile(join(cwd, "empty.txt"), "");

  const result = await executeTool(createReadTool({ cwd }), {
    path: "empty.txt",
  });

  assert.deepEqual(result, {
    path: "empty.txt",
    content: "",
    startLine: 0,
    endLine: 0,
    totalLines: 0,
    truncated: false,
  });
});

test("read rejects files over the byte limit and invalid UTF-8", async (t) => {
  const cwd = await createWorkspace(t);
  await writeFile(join(cwd, "large.txt"), "1234");
  await writeFile(join(cwd, "binary.dat"), Buffer.from([0xff, 0xfe]));

  await assert.rejects(
    executeTool(createReadTool({ cwd, maxBytes: 3 }), { path: "large.txt" }),
    assertErrorCode("CODING_TOOL_FILE_TOO_LARGE"),
  );
  await assert.rejects(
    executeTool(createReadTool({ cwd }), { path: "binary.dat" }),
    assertErrorCode("CODING_TOOL_NOT_TEXT"),
  );
});

test("read validates line limits and ranges", async (t) => {
  const cwd = await createWorkspace(t);
  await writeFile(join(cwd, "one.txt"), "one");
  const tool = createReadTool({ cwd, maxLines: 2 });

  assert.throws(
    () => tool.parse({ path: "one.txt", limit: 3 }),
    assertErrorCode("CODING_TOOL_INVALID_INPUT"),
  );
  await assert.rejects(
    executeTool(tool, { path: "one.txt", offset: 2 }),
    assertErrorCode("CODING_TOOL_READ_RANGE"),
  );
});
