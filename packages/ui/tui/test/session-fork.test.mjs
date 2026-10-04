import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { keyStroke } from "@may/keybindings";
import { SessionForkTree, SessionForkPicker, WorkspaceDiffViewer, workspaceGitLabel } from "../dist/index.js";

const positions = [
  { id: "root", sessionId: "original", runId: "run-1", createdAt: 1, userPreview: "Create file", assistantPreview: "File created", available: true, branch: "main", commit: "a".repeat(40), worktreeAvailable: true },
  { id: "next", parentPointId: "root", sessionId: "original", runId: "run-2", createdAt: 2, userPreview: "Update file", assistantPreview: "File updated", available: true, branch: "main", commit: "b".repeat(40), worktreeAvailable: true },
  { id: "fork", parentPointId: "root", sessionId: "independent", runId: "run-3", createdAt: 3, userPreview: "Another solution", assistantPreview: "Created another solution", available: true, branch: "codex/alternate", commit: "c".repeat(40), worktreeAvailable: false },
  { id: "unavailable", parentPointId: "fork", sessionId: "independent", runId: "run-4", createdAt: 4, userPreview: "Interrupted edit", assistantPreview: "", available: false, reason: "State was not saved" },
];
const key = value => keyStroke(value, value.length === 1 ? { text: value } : {});

test("history tree preserves fork ancestry, selects the newest complete current reply and searches collapsed descendants", () => {
  const tree = new SessionForkTree(positions, "original");
  assert.equal(tree.selected.id, "next");
  assert.deepEqual(tree.items.map(row => [row.point.id, row.depth]), [["root", 0], ["next", 1], ["fork", 1], ["unavailable", 2]]);
  tree.collapse(); assert.equal(tree.selected.id, "root");
  tree.move("home"); tree.collapse();
  assert.deepEqual(tree.items.map(row => row.point.id), ["root"]);
  tree.appendQuery("another");
  assert.equal(tree.selected.id, "fork");
  tree.clearQuery(); tree.move("home"); tree.expand();
  assert.equal(tree.items.length, 4);
  assert.throws(() => new SessionForkTree([positions[0], positions[0]]), /Duplicate/);
  assert.throws(() => new SessionForkTree([{ ...positions[0], parentPointId: "next" }, positions[1]]), /cycle/);
});

test("fork preview keeps navigation visible while paging long replies", () => {
  const picker = new SessionForkPicker([{ ...positions[0], assistantPreview: Array.from({ length: 40 }, (_, index) => `Reply line ${index}`).join("\n") }], { onComplete() {} });
  picker.handleKey(key("space"));
  let rendered = stripVTControlCharacters(picker.render({ width: 140, height: 18 }).lines.join("\n"));
  assert.match(rendered, /PgUp\/PgDn/); assert.doesNotMatch(rendered, /Reply line 20/);
  picker.handleKey(key("pagedown"));
  rendered = stripVTControlCharacters(picker.render({ width: 140, height: 18 }).lines.join("\n"));
  assert.match(rendered, /Reply line 10/); assert.match(rendered, /PgUp\/PgDn/);
});

test("fork picker selects current workspace and worktree entirely through keyboard input", () => {
  let result;
  const picker = new SessionForkPicker(positions, { currentSessionId: "original", onComplete: selection => { result = selection; } });
  picker.handleKey(key("space"));
  const preview = stripVTControlCharacters(picker.render({ width: 140, height: 24 }).lines.join("\n"));
  assert.match(preview, /File updated/);
  picker.handleKey(key("enter")); picker.handleKey(key("down")); picker.handleKey(key("enter"));
  assert.deepEqual(result, { pointId: "next", mode: "worktree" });
  const current = new SessionForkPicker(positions, { currentSessionId: "independent", onComplete: selection => { result = selection; } });
  current.handleKey(key("enter")); current.handleKey(key("down")); result = undefined;
  current.handleKey(key("enter")); assert.equal(result, undefined);
  current.handleKey(key("up")); current.handleKey(key("enter"));
  assert.deepEqual(result, { pointId: "fork", mode: "current" });
});

test("unavailable state cannot be selected; search and cancellation preserve explicit outcomes", () => {
  let cancelled = false;
  const picker = new SessionForkPicker(positions, { currentSessionId: "original", onComplete: () => { cancelled = true; } });
  picker.handleKey(key("end")); picker.handleKey(key("enter"));
  assert.match(stripVTControlCharacters(picker.render({ width: 140, height: 18 }).lines.join("\n")), /State was not saved/);
  assert.equal(cancelled, false);
  picker.handleKey(key("/"));
  for (const value of "another") picker.handleKey(key(value));
  picker.handleKey(key("enter")); assert.equal(picker.tree.selected.id, "fork");
  picker.handleKey(key("escape")); assert.equal(cancelled, true);
});

test("diff viewer browses text and binary files, searches and advances between change positions", () => {
  const patch = ["diff --git a/index.ts b/index.ts", "--- a/index.ts", "+++ b/index.ts", "@@ -1 +1 @@", "-old", "+new", " unchanged", "@@ -12 +12 @@", "-before", "+after"].join("\n");
  let closed = false;
  const view = new WorkspaceDiffViewer({ title: "Run changes", from: "a".repeat(40), to: "b".repeat(40), uncommitted: false, files: [
    { path: "index.ts", status: "modified", binary: false, additions: 2, deletions: 2, patch },
    { path: "picture.png", status: "added", binary: true, additions: 0, deletions: 0, patch: "" },
  ] }, { onClose: () => { closed = true; } });
  assert.match(stripVTControlCharacters(view.render({ width: 140, height: 12 }).lines.join("\n")), /2 个文件 · \+2 -2/);
  view.handleKey(key("enter")); view.render({ width: 140, height: 12 });
  view.handleKey(key("]")); assert.equal(view.scrollOffset, 3);
  view.handleKey(key("]")); assert.equal(view.scrollOffset, 7);
  view.handleKey(key("/")); for (const value of "after") view.handleKey(key(value)); view.handleKey(key("enter"));
  assert.equal(view.scrollOffset, 9);
  view.handleKey(key("escape")); view.handleKey(key("down")); view.handleKey(key("enter"));
  assert.match(stripVTControlCharacters(view.render({ width: 140, height: 12 }).lines.join("\n")), /二进制文件无法显示文本 diff/);
  view.handleKey(key("escape")); view.handleKey(key("escape")); assert.equal(closed, true);
});

test("Git labels represent branch, detached HEAD, initialization, disabled commits and errors", () => {
  assert.equal(workspaceGitLabel({ status: "ready", branch: "main" }), "main");
  assert.equal(workspaceGitLabel({ status: "ready", detached: true, commit: "abcdef123456789" }), "detached HEAD · abcdef123456");
  assert.equal(workspaceGitLabel({ status: "initializing" }), "Git 初始化中");
  assert.equal(workspaceGitLabel({ status: "ready", branch: "main", autoCommit: false }), "main · 自动提交关闭");
  assert.equal(workspaceGitLabel({ status: "error", error: "Missing Git" }), "Git 错误：Missing Git");
});
