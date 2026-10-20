import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { withFileAccess } from "../dist/file-access.js";

const testRoot = fileURLToPath(new URL("../../../review/file-access-tests/", import.meta.url));
const workerPath = new URL("./fixtures/file-access-worker.mjs", import.meta.url);

async function setup(t) {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, "access-"));
  const workers = [];
  t.after(async () => {
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill();
    }
    await Promise.all(workers.map(worker => worker.closed));
    assert.ok(resolve(directory).startsWith(`${resolve(testRoot)}${sep}`));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    path: join(directory, "state.json"),
    start(operation, path, mode) {
      const child = fork(workerPath, [operation, path, mode ?? "shared"], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
      const messages = [];
      child.on("message", message => { messages.push(message); });
      const closed = once(child, "close");
      const first = once(child, "message").then(([message]) => message);
      const worker = { child, messages, closed, first };
      workers.push(worker);
      return worker;
    },
  };
}

test("shared readers coexist and an exclusive writer waits for every reader", async t => {
  const { path, start } = await setup(t);
  const first = start("hold", path, "shared");
  const second = start("hold", path, "shared");
  assert.equal((await first.first).type, "acquired");
  assert.equal((await second.first).type, "acquired");
  await withFileAccess(path, "shared", async () => {});
  let entered = false;
  const writer = withFileAccess(path, "exclusive", async () => { entered = true; });
  await delay(100);
  assert.equal(entered, false);
  first.child.send("release");
  assert.deepEqual(await first.closed, [0, null]);
  await delay(100);
  assert.equal(entered, false);
  second.child.send("release");
  assert.deepEqual(await second.closed, [0, null]);
  await writer;
  assert.equal(entered, true);
});

test("process termination releases exclusive access for another process", async t => {
  const { path, start } = await setup(t);
  const holder = start("hold", path, "exclusive");
  await holder.first;
  const reader = start("hold", path, "shared");
  await delay(100);
  assert.equal(reader.messages.length, 0);
  holder.child.kill();
  await holder.closed;
  assert.equal((await reader.first).type, "acquired");
  reader.child.send("release");
  assert.deepEqual(await reader.closed, [0, null]);
  await withFileAccess(path, "exclusive", async () => {});
});

test("action errors release ownership and recursive access rejects immediately", async t => {
  const { path } = await setup(t);
  const failure = new Error("action failed");
  await assert.rejects(withFileAccess(path, "exclusive", async () => { throw failure; }), error => error === failure);
  await withFileAccess(path, "exclusive", async () => {
    await assert.rejects(withFileAccess(path, "shared", async () => {}), { code: "FILE_ACCESS_REENTRANT" });
  });
  assert.equal(await withFileAccess(path, "shared", async () => 42), 42);
});

test("read-only access requires initialized markers and preserves their contents", async t => {
  const { path, directory } = await setup(t);
  await assert.rejects(withFileAccess(path, "shared", async () => {}, { initialize: false }), { code: "FILE_ACCESS_NOT_INITIALIZED" });
  assert.deepEqual(await readdir(directory), []);
  await withFileAccess(path, "shared", async () => {});
  const markers = [`${path}.access`, `${path}.access.gate`];
  const before = await Promise.all(markers.map(marker => lstat(marker, { bigint: true })));
  await Promise.all(markers.map(marker => chmod(marker, 0o444)));
  try {
    await withFileAccess(path, "shared", async () => {}, { initialize: false });
    const after = await Promise.all(markers.map(marker => lstat(marker, { bigint: true })));
    assert.deepEqual(after.map(info => [info.ino, info.size, info.mtimeNs]), before.map(info => [info.ino, info.size, info.mtimeNs]));
    assert.deepEqual(await Promise.all(markers.map(marker => readFile(marker, "utf8"))), ["", ""]);
  } finally { await Promise.all(markers.map(marker => chmod(marker, 0o600))); }
});

test("directory markers and symbolic links fail before the action", async t => {
  const { path, directory } = await setup(t);
  await mkdir(`${path}.access`);
  let actions = 0;
  await assert.rejects(withFileAccess(path, "shared", async () => { actions += 1; }));
  const target = join(directory, "target");
  await mkdir(target);
  const linkedPath = join(directory, "linked.json");
  await symlink(target, `${linkedPath}.access`, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(withFileAccess(linkedPath, "shared", async () => { actions += 1; }));
  assert.equal(actions, 0);
});

test("continuous readers allow 300 atomic replacements and see complete content", { timeout: 60_000 }, async t => {
  const { path, start } = await setup(t);
  await writeFile(path, JSON.stringify({ revision: 0, payload: "0".repeat(4096) }));
  const readers = Array.from({ length: 16 }, () => start("read-loop", path));
  await Promise.all(readers.map(reader => reader.first));
  for (let revision = 1; revision <= 300; revision += 1) {
    await withFileAccess(path, "exclusive", async () => {
      const temporary = `${path}.tmp`;
      await writeFile(temporary, JSON.stringify({ revision, payload: String(revision).repeat(4096) }));
      await rename(temporary, path);
    });
  }
  for (const reader of readers) reader.child.send("stop");
  for (const reader of readers) {
    assert.deepEqual(await reader.closed, [0, null]);
    assert.ok(reader.messages.find(message => message.type === "stopped")?.reads > 0);
  }
  assert.equal(JSON.parse(await readFile(path, "utf8")).revision, 300);
});

test("a timed-out writer releases the entrance gate for later access", { timeout: 45_000 }, async t => {
  const { path, start } = await setup(t);
  const reader = start("hold", path, "shared");
  await reader.first;
  const started = performance.now();
  let actions = 0;
  await assert.rejects(withFileAccess(path, "exclusive", async () => { actions += 1; }), { code: "ETIMEDOUT" });
  assert.ok(performance.now() - started >= 30_000);
  assert.equal(actions, 0);
  await withFileAccess(path, "shared", async () => {});
  reader.child.send("release");
  assert.deepEqual(await reader.closed, [0, null]);
  await withFileAccess(path, "exclusive", async () => {});
});
