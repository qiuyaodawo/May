import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { InMemoryCoordinationStore } from "@may/coordination";
import { PluginHost } from "@may/plugin";
import { createCoordinationPlugin, coordinationService } from "../dist/index.js";

test("coordination plugin executes real file hashes and releases writer ownership across repeated cleanup", async t => {
  const base = fileURLToPath(new URL("../../../../plugin-verification/coordination/", import.meta.url));
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "graph-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "document.txt"), text = "Coordination file evidence";
  await writeFile(path, text);
  const store = new InMemoryCoordinationStore(), host = await PluginHost.create({ plugins: [createCoordinationPlugin()] });
  t.after(() => host.close());
  const service = host.get(coordinationService);
  const agents = { reader: {
    version: "file-sha256-v1",
    async execute(execution) {
      const output = { text: createHash("sha256").update(await readFile(execution.task.input)).digest("hex") };
      await writeFile(join(directory, execution.task.dispatchId + ".json"), JSON.stringify(output)); return output;
    },
    async recover(execution) {
      try { return { status: "completed", output: JSON.parse(await readFile(join(directory, execution.task.dispatchId + ".json"), "utf8")) }; }
      catch (error) { if (error.code === "ENOENT") return { status: "not-started" }; throw error; }
    },
  } };
  const policy = { version: "document-access-v1", authorize(task) { return task.agent === "reader" && task.input === path; } };
  const options = { id: "document-graph", store, agents, policy };
  const runtime = await service.create({ ...options, tasks: [{ id: "read-document", agent: "reader", input: path }] });
  await runtime.start();
  const result = await runtime.wait();
  assert.equal(result.tasks[0].status, "completed");
  assert.equal(result.tasks[0].output.text, createHash("sha256").update(text).digest("hex"));
  await Promise.all([runtime.close(), service.release(runtime), service.release(runtime)]);
  const reopened = await service.resume(options);
  assert.equal(reopened.snapshot().tasks[0].status, "completed");
  await host.close();
  const writer = await store.acquire(options.id); await writer.close();
});
