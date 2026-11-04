import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { acquireFileLock, withFileAccess } from "../packages/may/dist/storage/index.js";
import { targetFor, targetNames } from "./test-fixtures/file-lock-targets.mjs";
import { testOutputRoot } from "../packages/test-support/index.mjs";

const testRoot = join(testOutputRoot, "file-lock-matrix");
async function fixture(t, name) {
  await mkdir(testRoot, { recursive: true });
  const directory = await realpath(await mkdtemp(join(testRoot, `${name}-`)));
  const target = await targetFor(name, directory, true);
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.process.connected) child.process.send("release");
    await Promise.all(children.map((child) => child.closed));
    for (const path of target.cleanupFiles ?? []) await rm(path, { force: true });
    assert.ok(resolve(directory).startsWith(`${resolve(testRoot)}${sep}`));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    ...target,
    directory,
    start() {
      const process = fork(new URL("./test-fixtures/file-lock-worker.mjs", import.meta.url), [name, directory], {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      const closed = once(process, "close");
      const starting = Promise.withResolvers();
      const acquisition = Promise.withResolvers();
      process.on("message", (value) => {
        starting.resolve();
        if (value.type === "starting") return;
        if (value.type === "acquired") acquisition.resolve();
        else acquisition.reject(new Error(`Lock worker failed: ${JSON.stringify(value)}`));
      });
      const earlyExit = closed.then((value) => {
        throw new Error(`Lock worker exited before acquisition: ${value}`);
      });
      const ready = Promise.race([acquisition.promise, earlyExit]);
      const started = Promise.race([starting.promise, earlyExit]);
      void started.catch(() => {});
      const child = { process, closed, ready, started };
      children.push(child);
      return child;
    },
  };
}

async function waitForOwner(path, pid) {
  const deadline = performance.now() + 5_000;
  while (true) {
    try {
      if (JSON.parse(await readFile(`${path}.owner`, "utf8")).pid === pid) return;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    assert.ok(performance.now() < deadline, "Lock owner metadata was not written");
    await delay(10);
  }
}

for (const name of targetNames) {
  if (name !== "config" && name !== "patch") {
    test(
      `${name}: another process cannot acquire an owned lock; release permits acquisition`,
      { timeout: 20_000 },
      async (t) => {
        const f = await fixture(t, name);
        const holder = f.start();
        await holder.ready;
        await assert.rejects(f.acquire());
        assert.equal(JSON.parse(await readFile(`${f.lockPath}.owner`, "utf8")).pid, holder.process.pid);
        holder.process.send("release");
        assert.deepEqual(await holder.closed, [0, null]);
        const next = await f.acquire();
        await next.close();
      },
    );

    test(`${name}: process termination releases the lock without manual recovery`, { timeout: 20_000 }, async (t) => {
      const f = await fixture(t, name);
      const holder = f.start();
      await holder.ready;
      holder.process.kill("SIGKILL");
      await holder.closed;
      await stat(f.lockPath);
      const next = await f.acquire();
      await next.close();
    });
  }

  if (name !== "session") {
    test(`${name}: initialization failure releases its lock`, { timeout: 20_000 }, async (t) => {
      const f = await fixture(t, name);
      await mkdir(dirname(f.failurePath), { recursive: true });
      if (name === "config") await writeFile(f.failurePath, "{");
      else await mkdir(f.failurePath);
      await assert.rejects(f.acquire());
      const lock = await acquireFileLock(f.lockPath);
      await lock.release();
    });
  }
}

test(
  "config: concurrent update rejects while the accepted update waits for file access",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t, "config");
    let holder;
    await withFileAccess(f.dataPath, "exclusive", async () => {
      holder = f.start();
      await holder.started;
      await waitForOwner(f.lockPath, holder.process.pid);
      await assert.rejects(f.acquire(), { code: "MAY_CONFIG_WRITE_ERROR" });
    });
    await holder.ready;
    assert.deepEqual(await holder.closed, [0, null]);
    assert.equal(JSON.parse(await readFile(f.dataPath, "utf8")).defaultModel, "second");
  },
);

test(
  "config: terminating an accepted writer preserves the original configuration and releases the lock",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t, "config");
    const original = await readFile(f.dataPath, "utf8");
    await withFileAccess(f.dataPath, "exclusive", async () => {
      const holder = f.start();
      const rejected = assert.rejects(holder.ready);
      await holder.started;
      await waitForOwner(f.lockPath, holder.process.pid);
      holder.process.kill("SIGKILL");
      await holder.closed;
      await rejected;
      assert.equal(await readFile(f.dataPath, "utf8"), original);
    });
    const next = await f.acquire();
    await next.close();
  },
);
