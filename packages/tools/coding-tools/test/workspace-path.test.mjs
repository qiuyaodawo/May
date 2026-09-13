import assert from "node:assert/strict";
import { access, link, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  createEditTool,
  createReadTool,
  createWriteTool,
} from "../dist/index.js";
import { assertErrorCode, createWorkspace, executeTool } from "./helpers.mjs";

test("file tools reject lexical paths outside the workspace", async (t) => {
  const root = await createWorkspace(t);
  const cwd = join(root, "workspace");
  const outside = join(root, "outside.txt");
  await mkdir(cwd);
  await writeFile(outside, "secret");

  await assert.rejects(
    executeTool(createReadTool({ cwd }), { path: "../outside.txt" }),
    assertErrorCode("CODING_TOOL_PATH_OUTSIDE_WORKSPACE"),
  );
  await assert.rejects(
    executeTool(createWriteTool({ cwd }), {
      path: "../outside.txt",
      content: "changed",
    }),
    assertErrorCode("CODING_TOOL_PATH_OUTSIDE_WORKSPACE"),
  );
  await assert.rejects(
    executeTool(createEditTool({ cwd }), {
      path: "../outside.txt",
      oldText: "secret",
      newText: "changed",
    }),
    assertErrorCode("CODING_TOOL_PATH_OUTSIDE_WORKSPACE"),
  );
});

test("file tools reject symlinks that escape the workspace", async (t) => {
  const root = await createWorkspace(t);
  const cwd = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(cwd);
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "secret");
  try {
    await symlink(
      outside,
      join(cwd, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("creating symlinks is not permitted in this environment");
      return;
    }
    throw error;
  }

  await assert.rejects(
    executeTool(createReadTool({ cwd }), { path: "escape/secret.txt" }),
    assertErrorCode("CODING_TOOL_PATH_OUTSIDE_WORKSPACE"),
  );
  await assert.rejects(
    executeTool(createWriteTool({ cwd }), {
      path: "escape/new.txt",
      content: "new",
    }),
    assertErrorCode("CODING_TOOL_PATH_OUTSIDE_WORKSPACE"),
  );
  await assert.rejects(
    executeTool(createEditTool({ cwd }), {
      path: "escape/secret.txt",
      oldText: "secret",
      newText: "changed",
    }),
    assertErrorCode("CODING_TOOL_PATH_OUTSIDE_WORKSPACE"),
  );
});

test("write rejects a dangling symlink before creating its outside target", async (t) => {
  const root = await createWorkspace(t);
  const cwd = join(root, "workspace");
  const outside = join(root, "outside.txt");
  await mkdir(cwd);
  try {
    await symlink(outside, join(cwd, "escape.txt"), "file");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("creating symlinks is not permitted in this environment");
      return;
    }
    throw error;
  }

  await assert.rejects(
    executeTool(createWriteTool({ cwd }), {
      path: "escape.txt",
      content: "new",
    }),
    assertErrorCode("CODING_TOOL_PATH_OUTSIDE_WORKSPACE"),
  );
  await assert.rejects(access(outside), {
    code: "ENOENT",
  });
});

test("read permits hard links while mutations require explicit permission", async (t) => {
  const root = await createWorkspace(t);
  const cwd = join(root, "workspace");
  const outside = join(root, "outside.txt");
  await mkdir(cwd);
  await writeFile(outside, "secret");
  await link(outside, join(cwd, "linked.txt"));

  assert.equal((await executeTool(createReadTool({ cwd }), { path: "linked.txt" })).content, "secret");
  await assert.rejects(
    executeTool(createReadTool({ cwd, allowHardLinks: false }), { path: "linked.txt" }),
    assertErrorCode("CODING_TOOL_UNSAFE_HARD_LINK"),
  );
  await assert.rejects(
    executeTool(createEditTool({ cwd }), {
      path: "linked.txt",
      oldText: "secret",
      newText: "changed",
    }),
    assertErrorCode("CODING_TOOL_UNSAFE_HARD_LINK"),
  );
  await assert.rejects(
    executeTool(createWriteTool({ cwd }), {
      path: "linked.txt",
      content: "changed",
    }),
    assertErrorCode("CODING_TOOL_UNSAFE_HARD_LINK"),
  );
  assert.equal(await readFile(outside, "utf8"), "secret");
});
