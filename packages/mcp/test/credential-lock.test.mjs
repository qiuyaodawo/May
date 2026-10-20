import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { KeyringMcpCredentialStore } from "../dist/credentials.js";

const testRoot = fileURLToPath(new URL("../../../review/credential-lock-tests/", import.meta.url));
const key = "concurrent-credential";
async function setup(t) {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, "vault-"));
  const workers = [];
  t.after(async () => {
    for (const worker of workers) {
      if (worker.child.connected) worker.child.send("release");
    }
    await Promise.all(workers.map(worker => worker.closed));
    assert.ok(resolve(directory).startsWith(`${resolve(testRoot)}${sep}`));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    store: new KeyringMcpCredentialStore(directory),
    path: join(directory, `${createHash("sha256").update(key).digest("hex")}.lock`),
    start(operation) {
      const child = fork(new URL("./fixtures/credential-lock-worker.mjs", import.meta.url), [operation, directory, key], {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      const closed = once(child, "close");
      const first = Promise.race([
        once(child, "message").then(([message]) => message),
        closed.then(result => { throw new Error(`Worker exited before acquiring: ${result}`); }),
      ]);
      const worker = { child, closed, first };
      workers.push(worker);
      return worker;
    },
  };
}

test("credential acquisition waits for a Windows pending-delete handle to close", { skip: process.platform !== "win32", timeout: 15_000 }, async t => {
  const { store, path, start } = await setup(t);
  const holder = start("pending-delete");
  await holder.first;
  await assert.rejects(open(path, "wx"), { code: "EPERM" });
  let entered = false;
  let failure;
  const waiting = store.exclusive(key, async () => { entered = true; }).catch(error => { failure = error; });
  await delay(100);
  assert.equal(failure, undefined);
  assert.equal(entered, false);
  holder.child.send("release");
  assert.deepEqual(await holder.closed, [0, null]);
  await waiting;
  assert.equal(failure, undefined);
  assert.equal(entered, true);
});

test("credential locks serialize independent processes and retain access markers", { timeout: 30_000 }, async t => {
  const { store, directory, path, start } = await setup(t);
  await writeFile(join(directory, "counter.json"), "0");
  await store.exclusive(key, async () => {});
  const markers = [`${path}.access`, `${path}.access.gate`];
  const before = await Promise.all(markers.map(marker => lstat(marker, { bigint: true })));
  const workers = Array.from({ length: 8 }, () => start("increment"));
  await Promise.all(workers.map(worker => worker.first));
  for (const worker of workers) worker.child.send("start");
  for (const worker of workers) assert.deepEqual(await worker.closed, [0, null]);
  assert.equal(JSON.parse(await readFile(join(directory, "counter.json"), "utf8")), 320);
  const after = await Promise.all(markers.map(marker => lstat(marker, { bigint: true })));
  assert.deepEqual(after.map(info => [info.dev, info.ino, info.size, info.mtimeNs]), before.map(info => [info.dev, info.ino, info.size, info.mtimeNs]));
  await assert.rejects(lstat(path), { code: "ENOENT" });
});

test("credential cancellation does not enter work and releases the waiting guard", { timeout: 10_000 }, async t => {
  const { store, start } = await setup(t);
  const holder = start("hold");
  await holder.first;
  const controller = new AbortController();
  let entered = false;
  const waiting = store.exclusive(key, async () => { entered = true; }, controller.signal);
  const rejected = assert.rejects(waiting, { name: "AbortError" });
  await delay(100);
  controller.abort();
  await rejected;
  assert.equal(entered, false);
  holder.child.send("release");
  assert.deepEqual(await holder.closed, [0, null]);
  await store.exclusive(key, async () => { entered = true; });
  assert.equal(entered, true);
});

test("credential work errors release both locks and preserve the original error", async t => {
  const { store, path } = await setup(t);
  const failure = new Error("credential work failed");
  await assert.rejects(store.exclusive(key, async () => { throw failure; }), error => error === failure);
  await assert.rejects(lstat(path), { code: "ENOENT" });
  assert.equal(await store.exclusive(key, async () => 42), 42);
});

test("credential guard acquisition times out without entering work", { timeout: 15_000 }, async t => {
  const { store, start } = await setup(t);
  const holder = start("hold");
  await holder.first;
  const started = performance.now();
  let entered = false;
  await assert.rejects(store.exclusive(key, async () => { entered = true; }), {
    code: "MCP_CREDENTIAL_STORE_UNAVAILABLE", reason: "lock-timeout",
  });
  assert.ok(performance.now() - started >= 10_000);
  assert.equal(entered, false);
  holder.child.send("release");
  assert.deepEqual(await holder.closed, [0, null]);
  await store.exclusive(key, async () => {});
});

test("process termination preserves the credential owner file until explicit recovery", { timeout: 15_000 }, async t => {
  const { store, path, start } = await setup(t);
  const holder = start("hold");
  await holder.first;
  const owner = await readFile(path, "utf8");
  assert.equal(JSON.parse(owner).pid, holder.child.pid);
  holder.child.kill();
  await holder.closed;
  let entered = false;
  await assert.rejects(store.exclusive(key, async () => { entered = true; }), /verify its PID/u);
  assert.equal(entered, false);
  assert.equal(await readFile(path, "utf8"), owner);
  await rm(path);
  await store.exclusive(key, async () => { entered = true; });
  assert.equal(entered, true);
});
