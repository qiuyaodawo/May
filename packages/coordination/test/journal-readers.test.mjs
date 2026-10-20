import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FileCoordinationStore } from "../dist/file-store.js";
import { ResourceJournal } from "../dist/resource-journal.js";
import { limits } from "../dist/validation.js";

const maxBytes = 128 * 1024;
const content = "x".repeat(48 * 1024);
const validateResource = value => {
  assert.equal(value.format, 1);
  assert.equal(value.content, content);
};

for (const kind of ["coordination", "resource"]) {
  test(`${kind} checkpoints remain readable while another process inspects them`, { timeout: 20_000 }, async t => {
    const base = fileURLToPath(new URL("../../../review/coordination-journal-tests/", import.meta.url));
    await mkdir(base, { recursive: true });
    const directory = await mkdtemp(join(base, `${kind}-`));
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
    let current;
    if (kind === "coordination") {
      journal = await new FileCoordinationStore(directory, maxBytes).acquire("reading");
      current = {
        format: 1, id: "reading", revision: 1, policyVersion: "v1", limits: limits(),
        tasks: [{ id: "task", agent: "worker", agentVersion: "v1", sessionId: "session", dispatchId: "dispatch", input: content, dependsOn: [], status: "queued" }], commands: {},
      };
      await journal.commit(current, 0);
    } else {
      journal = await ResourceJournal.open(join(directory, "resource.jsonl"), { format: 1, revision: 0, content }, validateResource, maxBytes);
    }
    child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/journal-reader.mjs", import.meta.url)), kind, directory, String(maxBytes)], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    closed = once(child, "close");
    let errors = "";
    child.stderr.on("data", value => { errors += value; });
    await Promise.race([
      once(child, "message").then(([message]) => assert.equal(message.type, "ready")),
      closed.then(([code]) => { throw new Error(`Journal reader exited before readiness: ${code}; ${errors}`); }),
    ]);
    for (let index = 0; index < 64; index++) {
      if (kind === "coordination") {
        const next = { ...current, revision: current.revision + 1 };
        await journal.commit(next, current.revision);
        current = next;
      } else await journal.transact(value => ({ ...value }));
    }
    const result = once(child, "message");
    child.send("stop");
    const [report] = await Promise.race([
      result,
      closed.then(([code]) => { throw new Error(`Journal reader exited without its final report: ${code}; ${errors}`); }),
    ]);
    const [code] = await closed;
    assert.equal(code, 0, errors);
    assert.equal(report.type, "finished");
    assert.ok(report.reads > 0);
    assert.equal(report.revision, 65);
    assert.equal(errors, "");
    await journal.close();
    const beforeInspection = (await readdir(directory)).sort();
    const path = join(directory, kind === "coordination" ? `${Buffer.from("reading").toString("base64url")}.jsonl` : "resource.jsonl");
    await unlink(`${path}.access`);
    await unlink(`${path}.access.gate`);
    const inspected = kind === "coordination"
      ? await new FileCoordinationStore(directory, maxBytes).inspect("reading")
      : await ResourceJournal.inspect(path, validateResource, maxBytes);
    assert.equal(inspected.revision, 65);
    assert.deepEqual((await readdir(directory)).sort(), beforeInspection);
  });
}

test("inspection of missing journals leaves the directory unchanged", async t => {
  const base = fileURLToPath(new URL("../../../review/coordination-journal-tests/", import.meta.url));
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "missing-"));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(base) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(await new FileCoordinationStore(directory).inspect("missing"), undefined);
  await assert.rejects(ResourceJournal.inspect(join(directory, "missing.jsonl"), validateResource), { code: "ENOENT" });
  assert.deepEqual(await readdir(directory), []);
});
