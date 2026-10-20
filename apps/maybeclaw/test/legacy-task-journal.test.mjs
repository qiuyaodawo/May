import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FileTaskStore } from "../dist/store.js";
import { digest, taskId } from "../dist/types.js";

test("legacy task checkpoints remain readable while another process inspects them", { timeout: 60_000 }, async t => {
  const base = fileURLToPath(new URL("../../../review/maybeclaw-journal-tests/", import.meta.url));
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "readers-"));
  const store = new FileTaskStore(directory);
  const id = taskId("concurrent-inspection");
  let journal;
  let child;
  let closed;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    await journal?.close();
    assert.ok(resolve(directory).startsWith(resolve(base) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(await store.inspect(id), undefined);
  assert.deepEqual(await readdir(directory), []);
  journal = await store.acquire(id);
  const content = "x".repeat(65_536);
  let current = {
    version: 1, id, revision: 1, createdAt: 1, updatedAt: 1,
    spec: { requestId: "concurrent-inspection", prompt: content, configPath: join(directory, "config.json"),
      modelProfile: "inspection", modelFingerprint: digest("inspection"),
      runBudget: { maxDurationMs: 60_000, maxSteps: 4, maxModelCalls: 4, maxToolCalls: 4 } },
    status: "queued", verification: "unverified",
  };
  const update = async () => {
    const next = { ...current, revision: current.revision + 1, updatedAt: current.updatedAt + 1, status: current.status === "queued" ? "running" : "blocked" };
    await journal.write(next);
    current = next;
  };
  await journal.write(current);
  while (current.revision < 126) await update();
  child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/task-journal-reader.mjs", import.meta.url)), directory, id, content.length.toString()], { windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  closed = once(child, "close");
  let errors = "";
  child.stderr.on("data", value => { errors += value; });
  await Promise.race([
    once(child, "message").then(([message]) => assert.equal(message.type, "ready")),
    closed.then(([code]) => { throw new Error(`Task reader exited before readiness: ${code}; ${errors}`); }),
  ]);
  for (let index = 0; index < 260; index++) await update();
  const result = once(child, "message");
  child.send("stop");
  const [report] = await Promise.race([
    result,
    closed.then(([code]) => { throw new Error(`Task reader exited without its final report: ${code}; ${errors}`); }),
  ]);
  assert.equal((await closed)[0], 0, errors);
  assert.equal(report.type, "finished");
  assert.ok(report.reads > 0);
  assert.equal(report.revision, current.revision);
  assert.equal(errors, "");
  await journal.close();
  const path = store.path(id, "jsonl");
  const bytes = await readFile(path);
  assert.ok(bytes.length <= 8 * 1024 * 1024);
  assert.match(bytes.toString("utf8"), /^\{"checkpoint":/u);
  await unlink(`${path}.access`);
  await unlink(`${path}.access.gate`);
  assert.deepEqual(await store.inspect(id), current);
  assert.equal((await readdir(join(directory, "tasks"))).filter(name => name.endsWith(".access") || name.endsWith(".access.gate")).length, 2);
  await appendFile(path, '{"version":');
  assert.deepEqual(await store.inspect(id), current);
  journal = await store.acquire(id);
  assert.deepEqual(journal.read(), current);
  assert.deepEqual(await readFile(path), bytes);
});
