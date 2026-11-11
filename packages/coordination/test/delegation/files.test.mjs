import assert from "node:assert/strict";
import test from "node:test";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestDirectory } from "@sortedyuan/test-support";
import {
  SharedWorkspaceFileGuard,
  createWorkspaceFilesPlugin,
  workspaceFilesService,
} from "../../dist/delegation/index.js";
import { validateTaskFiles } from "../../dist/index.js";
import { PluginHost } from "@sortedyuan/may/plugin";
import { services, ToolSources } from "@sortedyuan/may/services";
import { createReadTool, resolveWritableWorkspacePath, workspaceFileKey } from "@sortedyuan/coding-tools";

function captureGuard(directory, options = {}) {
  let captured;
  const shared = new SharedWorkspaceFileGuard(directory, {
    toolFactories: {
      inspect_file(guard) {
        captured = guard;
        return { ...createReadTool({ cwd: directory, guard }), name: "inspect_file" };
      },
    },
  });
  const task = shared.create({ names: ["inspect_file"], requireRead: false, ...options });
  return { shared, task, guard: captured };
}

test("batch locks use sorted unique keys and release after failure", async (t) => {
  const directory = await createTestDirectory(t, "coordination/batch-order");
  const { shared, guard } = captureGuard(directory);
  const paths = await Promise.all(["b.txt", "a.txt"].map((path) => resolveWritableWorkspacePath(directory, path)));
  await assert.rejects(
    guard.runMany([...paths, paths[0]], "lsp_rename", async () => {
      assert.deepEqual([...shared.locks.keys()], paths.map(workspaceFileKey).sort());
      throw new Error("Operation failed");
    }),
    /Operation failed/u,
  );
  assert.equal(shared.locks.size, 0);
});

test("batch scope validation obtains no locks and concurrent reversed paths complete", async (t) => {
  const directory = await createTestDirectory(t, "coordination/batch-concurrency");
  const { shared, guard } = captureGuard(directory, { files: ["a.txt", "b.txt"] });
  const paths = await Promise.all(
    ["a.txt", "b.txt", "outside.txt"].map((path) => resolveWritableWorkspacePath(directory, path)),
  );
  const rejected = guard.runMany(paths, "lsp_rename", async () => assert.fail("Out-of-scope operation ran"));
  assert.equal(shared.locks.size, 0);
  await assert.rejects(rejected, /outside its assigned files/u);
  const completed = [];
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      guard.runMany(index % 2 === 0 ? paths.slice(0, 2) : paths.slice(0, 2).reverse(), "read", async () => {
        completed.push(index);
      }),
    ),
  );
  assert.equal(completed.length, 20);
  assert.equal(shared.locks.size, 0);
});

test("registered factory tools execute with a task guard and reject unknown names", async (t) => {
  const directory = await createTestDirectory(t, "coordination/factory-tools");
  await writeFile(join(directory, "notes.txt"), "Factory tool content");
  const { shared, task } = captureGuard(directory, { requireRead: true });
  const tool = task.tools[0];
  const result = await tool.execute(tool.parse({ path: "notes.txt" }), {
    runId: "factory",
    step: 1,
    toolCallId: "read",
    idempotencyKey: "factory-read",
    signal: new AbortController().signal,
    report() {},
  });
  assert.ok(JSON.stringify(result).includes("Factory tool content"));
  assert.throws(() => shared.create({ names: ["unknown"], requireRead: true }), /Unknown sub-agent tool/u);
});

test("batch writes retain task read requirements and track changed files", async (t) => {
  const directory = await createTestDirectory(t, "coordination/batch-versions");
  await writeFile(join(directory, "notes.txt"), "Original");
  const { guard, task } = captureGuard(directory, { requireRead: true });
  const path = await resolveWritableWorkspacePath(directory, "notes.txt");
  await assert.rejects(
    guard.runMany([path], "lsp_rename", async () => {
      assert.fail("Unread file was modified");
    }),
    /has not read/u,
  );
  await guard.runMany([path], "read", () => readFile(path.absolute, "utf8"));
  await guard.runMany([path], "lsp_rename", () => writeFile(path.absolute, "Updated"));
  assert.equal(await readFile(path.absolute, "utf8"), "Updated");
  assert.deepEqual(task.changedFiles(), ["notes.txt"]);
  await writeFile(path.absolute, "External change");
  await assert.rejects(
    guard.runMany([path], "lsp_rename", async () => {
      assert.fail("Changed file was modified");
    }),
    /changed after/u,
  );
});

test("workspace plugin passes factories and file feedback to task tools", async (t) => {
  const directory = await createTestDirectory(t, "coordination/plugin-factories");
  const records = [];
  const sources = new ToolSources();
  const host = await PluginHost.create({
    plugins: [
      createWorkspaceFilesPlugin({
        workspace: directory,
        fileFeedback: {
          record(path, content) {
            records.push({ path: path.relative, content });
          },
        },
        toolFactories: {
          inspect_file: (guard) => ({ ...createReadTool({ cwd: directory, guard }), name: "inspect_file" }),
        },
      }),
    ],
    services: [{ service: services.toolSources, value: sources }],
  });
  t.after(() => host.close());
  const application = await host.createScope("application", { id: "factory-files" });
  const task = application.get(workspaceFilesService).create({ names: ["write", "inspect_file"], requireRead: true });
  const context = {
    runId: "plugin",
    step: 1,
    toolCallId: "write",
    idempotencyKey: "plugin-write",
    signal: new AbortController().signal,
    report() {},
  };
  const write = task.tools[0];
  await write.execute(write.parse({ path: "notes.txt", content: "Recorded content" }), context);
  assert.deepEqual(records, [{ path: "notes.txt", content: "Recorded content" }]);
  const read = task.tools[1];
  const result = await read.execute(read.parse({ path: "notes.txt" }), context);
  assert.ok(JSON.stringify(result).includes("Recorded content"));
});

test("workspace files plugin creates real tools and removes its catalog contribution on close", async () => {
  const sources = new ToolSources();
  const host = await PluginHost.create({
    plugins: [createWorkspaceFilesPlugin({ workspace: process.cwd() })],
    services: [{ service: services.toolSources, value: sources }],
  });
  const application = await host.createScope("application", { id: "files" });
  assert.ok(application.get(workspaceFilesService) instanceof SharedWorkspaceFileGuard);
  assert.deepEqual(
    [...sources.snapshot()].map((tool) => tool.name),
    ["read", "shell", "edit", "write", "glob", "grep", "fetch"],
  );
  await host.close();
  assert.equal(sources.snapshot().size, 0);
});

test("actual file changes require a task read and reject changes after another writer", async (t) => {
  const directory = await createTestDirectory(t, "coordination/delegation-files");
  await writeFile(join(directory, "notes.txt"), "Existing notes.");
  const guard = new SharedWorkspaceFileGuard(directory).create({
    names: ["read", "write"],
    requireRead: true,
    files: ["notes.txt"],
  });
  const read = guard.tools.find((tool) => tool.name === "read");
  const write = guard.tools.find((tool) => tool.name === "write");
  const context = {
    runId: "files",
    step: 1,
    toolCallId: "read",
    idempotencyKey: "files-read",
    signal: new AbortController().signal,
    report() {},
  };
  await assert.rejects(
    write.execute(write.parse({ path: "notes.txt", content: "Changed notes." }), context),
    /has not read/u,
  );
  await read.execute(read.parse({ path: "notes.txt" }), context);
  await writeFile(join(directory, "notes.txt"), "Another writer changed the file.");
  await assert.rejects(
    write.execute(write.parse({ path: "notes.txt", content: "Changed notes." }), context),
    /changed after/u,
  );
  await read.execute(read.parse({ path: "notes.txt" }), context);
  await write.execute(write.parse({ path: "notes.txt", content: "Changed notes." }), context);
  assert.equal(await readFile(join(directory, "notes.txt"), "utf8"), "Changed notes.");
  assert.deepEqual(guard.changedFiles(), ["notes.txt"]);
});

test("an empty files list is accepted and allows reads without modifications", async (t) => {
  const directory = await createTestDirectory(t, "coordination/delegation-files");
  await writeFile(join(directory, "notes.txt"), "Existing notes.");
  validateTaskFiles([]);
  const guard = new SharedWorkspaceFileGuard(directory).create({
    names: ["read", "write"],
    requireRead: true,
    files: [],
  });
  const read = guard.tools.find((tool) => tool.name === "read");
  const write = guard.tools.find((tool) => tool.name === "write");
  const context = {
    runId: "files",
    step: 1,
    toolCallId: "read",
    idempotencyKey: "files-read",
    signal: new AbortController().signal,
    report() {},
  };
  await read.execute(read.parse({ path: "notes.txt" }), context);
  await assert.rejects(
    write.execute(write.parse({ path: "notes.txt", content: "Changed notes." }), context),
    /may not modify files/u,
  );
  assert.equal(await readFile(join(directory, "notes.txt"), "utf8"), "Existing notes.");
});
