import assert from "node:assert/strict";
import { link, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createToolChangePreview } from "../dist/index.js";

test("previews a newly written file as a unified diff", async (t) => {
  const workspace = await temporaryDirectory(t);
  const preview = await createToolChangePreview(workspace, "write", {
    path: "new.txt",
    content: "one\ntwo\n",
  });

  assert.equal(preview.status, "ready");
  assert.equal(preview.kind, "create");
  assert.equal(preview.additions, 2);
  assert.equal(preview.deletions, 0);
  assert.equal(
    preview.diff,
    [
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
    ].join("\n"),
  );
});

test("previews write updates with context and a modification summary", async (t) => {
  const workspace = await temporaryDirectory(t);
  await writeFile(join(workspace, "file.txt"), "one\nold\nthree\n", "utf8");

  const preview = await createToolChangePreview(workspace, "write", {
    path: "file.txt",
    content: "one\nnew\nthree\n",
  });

  assert.equal(preview.status, "ready");
  assert.equal(preview.kind, "update");
  assert.equal(preview.additions, 1);
  assert.equal(preview.deletions, 1);
  assert.match(preview.diff, / one\n-old\n\+new\n three/u);
});

test("previews an exact edit and detects unchanged content", async (t) => {
  const workspace = await temporaryDirectory(t);
  await writeFile(join(workspace, "file.txt"), "before value after", "utf8");

  const edited = await createToolChangePreview(workspace, "edit", {
    path: "file.txt",
    oldText: "value",
    newText: "updated",
  });
  assert.equal(edited.status, "ready");
  assert.equal(edited.kind, "update");
  assert.match(
    edited.diff,
    /-before value after\n\\ No newline at end of file\n\+before updated after/u,
  );

  const unchanged = await createToolChangePreview(workspace, "write", {
    path: "file.txt",
    content: "before value after",
  });
  assert.equal(unchanged.status, "ready");
  assert.equal(unchanged.kind, "no-change");
  assert.equal(unchanged.additions, 0);
  assert.equal(unchanged.deletions, 0);
  assert.equal(unchanged.diff, "");
});

test("does not read outside the workspace for a preview", async (t) => {
  const workspace = await temporaryDirectory(t);
  const preview = await createToolChangePreview(workspace, "write", {
    path: "../outside.txt",
    content: "no",
  });

  assert.equal(preview.status, "unavailable");
  assert.match(preview.reason, /outside the workspace/u);
});

test("reports an ambiguous edit without blocking the permission flow", async (t) => {
  const workspace = await temporaryDirectory(t);
  await writeFile(join(workspace, "file.txt"), "same same", "utf8");
  const preview = await createToolChangePreview(workspace, "edit", {
    path: "file.txt",
    oldText: "same",
    newText: "new",
  });

  assert.equal(preview.status, "unavailable");
  assert.match(preview.reason, /more than once/u);
});

test("bounds large diff output", async (t) => {
  const workspace = await temporaryDirectory(t);
  const content = Array.from({ length: 400 }, (_value, index) => `line ${index}`)
    .join("\n");
  const preview = await createToolChangePreview(workspace, "write", {
    path: "large.txt",
    content,
  });

  assert.equal(preview.status, "ready");
  assert.match(preview.diff, /184 diff lines omitted/u);
  assert.ok(preview.diff.split("\n").length < 230);
});

test("shows EOF newline changes and rejects hard-linked previews", async (t) => {
  const workspace = await temporaryDirectory(t);
  await writeFile(join(workspace, "eof.txt"), "a", "utf8");
  const eof = await createToolChangePreview(workspace, "write", {
    path: "eof.txt",
    content: "a\n",
  });
  assert.equal(eof.status, "ready");
  assert.equal(eof.additions, 1);
  assert.equal(eof.deletions, 1);
  assert.match(eof.diff, /No newline at end of file/u);

  await writeFile(join(workspace, "endings.txt"), "a\r\n", "utf8");
  const endings = await createToolChangePreview(workspace, "write", {
    path: "endings.txt",
    content: "a\n",
  });
  assert.equal(endings.status, "ready");
  assert.match(endings.diff, /Line ending: CRLF/u);
  assert.notEqual(endings.diff, "");

  await writeFile(join(workspace, "bom.txt"), "\uFEFFvalue", "utf8");
  const bom = await createToolChangePreview(workspace, "write", {
    path: "bom.txt",
    content: "value",
  });
  assert.equal(bom.status, "ready");
  assert.match(bom.diff, /UTF-8 BOM/u);
  assert.notEqual(bom.diff, "");

  const external = join(await temporaryDirectory(t), "external.txt");
  await writeFile(external, "secret", "utf8");
  await link(external, join(workspace, "linked.txt"));
  const linked = await createToolChangePreview(workspace, "write", {
    path: "linked.txt",
    content: "replacement",
  });
  assert.equal(linked.status, "unavailable");
  assert.match(linked.reason, /hard-linked files cannot be previewed/u);
});

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "may-coding-preview-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
