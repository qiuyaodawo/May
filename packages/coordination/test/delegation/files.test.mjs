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
    ["read", "shell", "edit", "write"],
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
