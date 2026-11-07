import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createGlobTool } from "../dist/glob.js";
import { createGrepTool } from "../dist/grep.js";

async function executeTool(tool, input, signal = new AbortController().signal) {
  return tool.execute(await tool.parse(input), {
    runId: "search-test",
    step: 1,
    toolCallId: "search-test",
    idempotencyKey: "search-test",
    signal,
    report() {},
  });
}

async function workspace(t) {
  const root = fileURLToPath(new URL("../../../../review/impl-batch-b/search-tests/", import.meta.url));
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(join(root, "workspace-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, ".gitignore"), "ignored.txt\n");
  await writeFile(join(cwd, "ignored.txt"), "needle\n");
  await writeFile(join(cwd, ".hidden.txt"), "needle\n");
  await writeFile(join(cwd, "notes.txt"), "Needle one\nneedle two\n");
  return cwd;
}

test("glob respects ignore rules, hidden selection, and result limits", async (t) => {
  const cwd = await workspace(t);
  assert.deepEqual(await executeTool(createGlobTool({ cwd }), { pattern: "*.txt" }), {
    paths: ["notes.txt"],
    truncated: false,
  });
  const hidden = await executeTool(createGlobTool({ cwd }), { pattern: "*.txt", includeHidden: true });
  assert.deepEqual([...hidden.paths].sort(), [".hidden.txt", "notes.txt"]);
  const limited = await executeTool(createGlobTool({ cwd, maxResults: 1 }), { pattern: "*.txt", includeHidden: true });
  assert.equal(limited.paths.length, 1);
  assert.equal(limited.truncated, true);
});

test("grep returns matching lines with literal and case options", async (t) => {
  const cwd = await workspace(t);
  const result = await executeTool(createGrepTool({ cwd }), { pattern: "needle", literal: true, caseSensitive: false });
  assert.deepEqual(result, {
    matches: [
      { file: "notes.txt", line: 1, text: "Needle one" },
      { file: "notes.txt", line: 2, text: "needle two" },
    ],
    truncated: false,
  });
  const limited = await executeTool(createGrepTool({ cwd, maxResults: 1 }), {
    pattern: "needle",
    caseSensitive: false,
  });
  assert.equal(limited.matches.length, 1);
  assert.equal(limited.truncated, true);
  const bounded = await executeTool(createGrepTool({ cwd, maxOutputBytes: 10 }), { pattern: "needle" });
  assert.equal(bounded.truncated, true);
  const filtered = await executeTool(createGrepTool({ cwd }), {
    pattern: "needle",
    glob: "*.txt",
    caseSensitive: false,
  });
  assert.deepEqual(filtered, result);
});

test("search rejects paths outside the workspace and cancelled calls", async (t) => {
  const cwd = await workspace(t);
  await assert.rejects(executeTool(createGlobTool({ cwd }), { pattern: "*", path: ".." }), {
    code: "CODING_TOOL_PATH_OUTSIDE_WORKSPACE",
  });
  const signal = AbortSignal.abort(new Error("search cancelled"));
  await assert.rejects(executeTool(createGrepTool({ cwd }), { pattern: "needle" }, signal), /search cancelled/u);
  await assert.rejects(executeTool(createGrepTool({ cwd }), { pattern: "[" }), { code: "CODING_TOOL_SEARCH_PROCESS" });
});
