import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { withFileAccess } from "../packages/session/dist/file-access.js";
import { acquireFileLock, releaseFileLock } from "../packages/session/dist/file-store.js";
import { targetFor, targetNames } from "./test-fixtures/file-lock-targets.mjs";

const testRoot = fileURLToPath(new URL("../review/file-lock-matrix/", import.meta.url));
async function fixture(t, name) {
  await mkdir(testRoot, { recursive: true });
  const directory = await realpath(await mkdtemp(join(testRoot, `${name}-`)));
  const target = await targetFor(name, directory, true);
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.process.connected) child.process.send("release");
    await Promise.all(children.map(child => child.closed));
    for (const path of target.cleanupFiles ?? []) await rm(path, { force: true });
    assert.ok(resolve(directory).startsWith(`${resolve(testRoot)}${sep}`));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    ...target, directory,
    start(operation = "owner") {
      const worker = operation === "guard"
        ? new URL("../packages/file-storage/test/fixtures/file-access-worker.mjs", import.meta.url)
        : new URL("./test-fixtures/file-lock-worker.mjs", import.meta.url);
      const args = operation === "guard" ? ["hold", target.lockPath, "exclusive"] : [name, directory];
      const process = fork(worker, args, {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      const closed = once(process, "close");
      const starting = Promise.withResolvers();
      const acquisition = Promise.withResolvers();
      process.on("message", value => {
        starting.resolve();
        if (value.type === "starting") return;
        if (value.type === "acquired") acquisition.resolve();
        else acquisition.reject(new Error(`Lock worker failed: ${JSON.stringify(value)}`));
      });
      const earlyExit = closed.then(value => { throw new Error(`Lock worker exited before acquisition: ${value}`); });
      const ready = Promise.race([acquisition.promise, earlyExit]);
      const started = Promise.race([starting.promise, earlyExit]);
      void started.catch(() => {});
      const child = { process, closed, ready, started };
      children.push(child);
      return child;
    },
  };
}

async function pendingDelete(path) {
  const process = spawn("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-File",
    fileURLToPath(new URL("../packages/mcp/test/fixtures/pending-delete.ps1", import.meta.url)),
    "-TargetPath", path,
  ], { windowsHide: true, stdio: ["pipe", "pipe", "inherit"] });
  const closed = once(process, "close");
  const lines = createInterface({ input: process.stdout });
  await Promise.race([
    once(lines, "line").then(([line]) => assert.equal(line, "delete-pending")),
    closed.then(value => { throw new Error(`Delete process exited before readiness: ${value}`); }),
  ]);
  return async () => {
    process.stdin.end("\n");
    assert.deepEqual(await closed, [0, null]);
    lines.close();
  };
}

for (const name of targetNames) {
  if (name !== "config" && name !== "patch") {
    test(`${name}: another process cannot acquire an owned lock; release permits acquisition`, { timeout: 20_000 }, async t => {
      const f = await fixture(t, name);
      const holder = f.start();
      await holder.ready;
      const owner = await readFile(f.lockPath, "utf8");
      await assert.rejects(f.acquire());
      assert.equal(await readFile(f.lockPath, "utf8"), owner);
      holder.process.send("release");
      assert.deepEqual(await holder.closed, [0, null]);
      await assert.rejects(stat(f.lockPath), { code: "ENOENT" });
      const next = await f.acquire();
      await next.close();
    });

    test(`${name}: process termination follows the documented lock recovery rule`, { timeout: 20_000 }, async t => {
      const f = await fixture(t, name);
      const holder = f.start();
      await holder.ready;
      const contents = await readFile(f.lockPath, "utf8");
      holder.process.kill();
      await holder.closed;
      assert.equal(await readFile(f.lockPath, "utf8"), contents);
      if (!f.automaticRecovery) {
        await assert.rejects(f.acquire());
        assert.equal(await readFile(f.lockPath, "utf8"), contents);
        await rm(f.lockPath);
      }
      const next = await f.acquire();
      await next.close();
    });
  }

  test(`${name}: Windows pending deletion rejects acquisition and completion permits acquisition`, {
    skip: process.platform !== "win32", timeout: 20_000,
  }, async t => {
    const f = await fixture(t, name);
    await writeFile(f.lockPath, JSON.stringify({ pid: process.pid, hostname: hostname() }), { flag: "wx" });
    const release = await pendingDelete(f.lockPath);
    try {
      await assert.rejects(f.acquire(), error => {
        t.diagnostic(`pending-delete result: ${error.name}, ${error.code ?? error.cause?.code ?? error.message}`);
        return true;
      });
    } finally { await release(); }
    await assert.rejects(stat(f.lockPath), { code: "ENOENT" });
    const next = await f.acquire();
    await next.close();
  });

  if (name !== "session") {
    test(`${name}: initialization failure releases its newly created lock`, { timeout: 20_000 }, async t => {
      const f = await fixture(t, name);
      await mkdir(dirname(f.failurePath), { recursive: true });
      if (name === "config") await writeFile(f.failurePath, "{");
      else await mkdir(f.failurePath);
      await assert.rejects(f.acquire());
      await assert.rejects(stat(f.lockPath), { code: "ENOENT" });
    });
  }
}

test("config: concurrent update rejects while the accepted update waits for file access", { timeout: 20_000 }, async t => {
  const f = await fixture(t, "config");
  let holder;
  await withFileAccess(f.dataPath, "exclusive", async () => {
    holder = f.start();
    await holder.started;
    const deadline = performance.now() + 5_000;
    while (true) {
      try { await stat(f.lockPath); break; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      assert.ok(performance.now() < deadline, "Config writer did not create its lock");
      await delay(10);
    }
    await assert.rejects(f.acquire(), { code: "MAY_CONFIG_WRITE_ERROR" });
  });
  await holder.ready;
  assert.deepEqual(await holder.closed, [0, null]);
  await assert.rejects(stat(f.lockPath), { code: "ENOENT" });
  assert.equal(JSON.parse(await readFile(f.dataPath, "utf8")).defaultModel, "second");
});

for (const name of ["session", "coordination", "resource", "verification", "task", "git", "patch", "worker", "setup", "config"]) {
  test(`${name}: acquisition waits for a coordinated Windows lock deletion to complete`, {
    skip: process.platform !== "win32", timeout: 20_000,
  }, async t => {
    const f = await fixture(t, name);
    let waiter;
    let acquired = false;
    let failure;
    await withFileAccess(f.lockPath, "exclusive", async () => {
      await writeFile(f.lockPath, JSON.stringify({ pid: process.pid, hostname: hostname() }), { flag: "wx" });
      const release = await pendingDelete(f.lockPath);
      try {
        waiter = f.start();
        void waiter.ready.then(() => { acquired = true; }, error => { failure = error; });
        await waiter.started;
        await delay(600);
        assert.equal(failure, undefined);
        assert.equal(acquired, false);
      } finally { await release(); }
    });
    await waiter.ready;
    if (!f.oneShot) waiter.process.send("release");
    assert.deepEqual(await waiter.closed, [0, null]);
    const next = await f.acquire();
    await next.close();
  });
}

test("git: a writer that has created its lock but has not written metadata reports a conflict", async t => {
  const f = await fixture(t, "git");
  await writeFile(f.lockPath, "", { flag: "wx" });
  await assert.rejects(f.acquire(), { name: "GitWorkspaceConflictError" });
  assert.equal(await readFile(f.lockPath, "utf8"), "");
});

test("session: failure to coordinate release closes the owned handle and preserves recovery evidence", async t => {
  const f = await fixture(t, "session");
  const file = await acquireFileLock(f.lockPath);
  const owner = JSON.stringify({ pid: process.pid, hostname: hostname() });
  await file.writeFile(owner);
  try {
    await rename(`${f.lockPath}.access`, `${f.lockPath}.access.original`);
    await mkdir(`${f.lockPath}.access`);
    await assert.rejects(releaseFileLock(file, f.lockPath));
    await assert.rejects(file.stat(), { code: "EBADF" });
    assert.equal(await readFile(f.lockPath, "utf8"), owner);
  } finally { await file.close(); }
});

test("git: concurrent close calls both wait for the actual release", { timeout: 20_000 }, async t => {
  const f = await fixture(t, "git");
  const owner = await f.acquire();
  const guard = f.start("guard");
  await guard.ready;
  let closed = 0;
  const first = owner.close().then(() => { closed += 1; });
  const second = owner.close().then(() => { closed += 1; });
  try {
    await delay(100);
    assert.equal(closed, 0);
  } finally { guard.process.send("release"); }
  assert.deepEqual(await guard.closed, [0, null]);
  await Promise.all([first, second]);
  assert.equal(closed, 2);
  await assert.rejects(stat(f.lockPath), { code: "ENOENT" });
});

test("config: terminating an accepted writer preserves its owner file and original configuration", { timeout: 20_000 }, async t => {
  const f = await fixture(t, "config");
  const original = await readFile(f.dataPath, "utf8");
  await withFileAccess(f.dataPath, "exclusive", async () => {
    const holder = f.start();
    const rejected = assert.rejects(holder.ready);
    await holder.started;
    const deadline = performance.now() + 5_000;
    let owner;
    while (true) {
      let contents;
      try { contents = await readFile(f.lockPath, "utf8"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (contents) { owner = JSON.parse(contents); break; }
      assert.ok(performance.now() < deadline, "Config owner metadata was not written");
      await delay(10);
    }
    assert.equal(owner.pid, holder.process.pid);
    holder.process.kill();
    await holder.closed;
    await rejected;
    assert.equal(await readFile(f.dataPath, "utf8"), original);
    await assert.rejects(f.acquire(), { code: "MAY_CONFIG_WRITE_ERROR" });
    assert.equal(JSON.parse(await readFile(f.lockPath, "utf8")).pid, owner.pid);
    await rm(f.lockPath);
  });
  const next = await f.acquire();
  await next.close();
});
