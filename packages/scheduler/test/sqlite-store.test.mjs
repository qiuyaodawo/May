import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, linkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SqliteSchedulerStore } from "../dist/sqlite-store.js";
import { cleanupOperations, fixture } from "./fixtures/sqlite-fixture.mjs";

if (process.argv[2] === "--owner") {
  const store = SqliteSchedulerStore.open(process.argv[3]);
  store.put("meta", "committed", { value: "preserved" });
  if (process.argv[4] === "--transaction") {
    store.transaction(() => {
      store.put("meta", "uncommitted", { value: "unfinished" });
      process.send({ type: "ready", pid: process.pid });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    });
    store.close();
  } else {
    process.send({ type: "ready", pid: process.pid });
    setInterval(() => {}, 60_000);
  }
} else {
  test("persists JSON collections and isolates stored values from caller mutations", (t) => {
    const path = fixture(t);
    const store = SqliteSchedulerStore.open(path);
    const input = { array: [{ value: "original" }], count: 1 };
    store.put("jobs", "b", input);
    store.put("jobs", "a", { value: "first" });
    input.array[0].value = "caller modified";
    const value = store.get("jobs", "b");
    assert.equal(value.array[0].value, "original");
    value.array[0].value = "reader modified";
    assert.equal(store.get("jobs", "b").array[0].value, "original");
    assert.deepEqual(
      store.list("jobs").map((record) => record.value ?? record.count),
      ["first", 1],
    );
    assert.equal(store.get("events", "missing"), undefined);
    store.put("jobs", "a", { value: "updated" });
    store.delete("jobs", "b");
    store.delete("jobs", "missing");
    store.close();
    store.close();

    const reopened = SqliteSchedulerStore.open(path);
    try {
      assert.deepEqual(reopened.list("jobs"), [{ value: "updated" }]);
    } finally {
      reopened.close();
    }
    assert.equal(existsSync(`${path}.scheduler-lock.sqlite`), true);
  });

  test("commits and rolls back multi-collection transactions and nested savepoints", (t) => {
    const store = SqliteSchedulerStore.open(fixture(t));
    cleanupOperations.get(t).push(() => store.close());
    assert.equal(
      store.transaction(() => {
        store.put("jobs", "job", { revision: 1 });
        store.transaction(() => store.put("executions", "execution", { status: "pending" }));
        return "committed";
      }),
      "committed",
    );
    assert.deepEqual(store.get("executions", "execution"), { status: "pending" });

    assert.throws(
      () =>
        store.transaction(() => {
          store.put("jobs", "job", { revision: 2 });
          store.put("events", "event", { topic: "created" });
          throw new Error("transaction validation failed");
        }),
      /transaction validation failed/u,
    );
    assert.deepEqual(store.get("jobs", "job"), { revision: 1 });
    assert.equal(store.get("events", "event"), undefined);

    store.transaction(() => {
      assert.throws(
        () =>
          store.transaction(() => {
            store.delete("jobs", "job");
            throw new Error("nested transaction failed");
          }),
        /nested transaction failed/u,
      );
      store.put("meta", "sequence", 1);
    });
    assert.deepEqual(store.get("jobs", "job"), { revision: 1 });
    assert.equal(store.get("meta", "sequence"), 1);
  });

  test("rejects asynchronous transactions before they can write and rolls back Promise results", (t) => {
    const store = SqliteSchedulerStore.open(fixture(t));
    cleanupOperations.get(t).push(() => store.close());
    assert.throws(
      () =>
        store.transaction(async () => {
          store.put("meta", "async", 1);
        }),
      /synchronous callback/u,
    );
    assert.equal(store.get("meta", "async"), undefined);
    assert.throws(
      () =>
        store.transaction(() => {
          store.put("meta", "promise", 1);
          return Promise.resolve();
        }),
      /cannot return a Promise/u,
    );
    assert.equal(store.get("meta", "promise"), undefined);
    assert.throws(() => store.transaction(() => store.close()), /during a transaction/u);
    store.put("meta", "after-error", true);
  });

  test("validates collections, identifiers, JSON values and closed stores", (t) => {
    const store = SqliteSchedulerStore.open(fixture(t));
    cleanupOperations.get(t).push(() => store.close());
    for (const operation of [
      () => store.get("unknown", "id"),
      () => store.list("unknown"),
      () => store.put("unknown", "id", null),
      () => store.delete("unknown", "id"),
      () => store.put("jobs", "", null),
      () => store.get("jobs", "invalid\0id"),
      () => store.delete("jobs", ""),
    ])
      assert.throws(operation, TypeError);
    const cycle = {};
    cycle.self = cycle;
    for (const value of [undefined, Number.NaN, Infinity, 1n, { value: undefined }, new Date(), cycle, Array(2)]) {
      assert.throws(() => store.put("meta", "invalid", value), TypeError);
    }
    assert.deepEqual(store.list("meta"), []);
    store.close();
    for (const operation of [
      () => store.get("jobs", "id"),
      () => store.list("jobs"),
      () => store.put("jobs", "id", null),
      () => store.delete("jobs", "id"),
      () => store.transaction(() => {}),
    ])
      assert.throws(operation, /closed/u);
  });

  test("enforces the individual JSON record limit while allowing larger collection results", (t) => {
    const store = SqliteSchedulerStore.open(fixture(t));
    cleanupOperations.get(t).push(() => store.close());
    const maximum = "a".repeat(1024 * 1024 - 2);
    store.put("meta", "maximum", maximum);
    assert.equal(store.get("meta", "maximum").length, maximum.length);
    assert.throws(() => store.put("meta", "oversized", `${maximum}a`), RangeError);
    assert.equal(store.get("meta", "oversized"), undefined);
    assert.throws(
      () =>
        store.transaction(() => {
          store.put("meta", "transaction", "pending");
          store.put("meta", "oversized", `${maximum}a`);
        }),
      RangeError,
    );
    assert.equal(store.get("meta", "transaction"), undefined);
    store.put("meta", "second", "b".repeat(700_000));
    const records = store.list("meta");
    assert.equal(records.length, 2);
    assert.ok(Buffer.byteLength(JSON.stringify(records)) > 1024 * 1024);
  });

  test("uses WAL and FULL synchronization and rejects simultaneous owners", (t) => {
    const path = fixture(t);
    const store = SqliteSchedulerStore.open(path);
    cleanupOperations.get(t).push(() => store.close());
    assert.throws(() => SqliteSchedulerStore.open(path), /active owner/u);
    assert.throws(() => SqliteSchedulerStore.open(join(path, "..", "scheduler.sqlite")), /active owner/u);
    if (process.platform === "win32")
      assert.throws(() => SqliteSchedulerStore.open(path.toUpperCase()), /active owner/u);
    const inspection = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(inspection.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
      assert.equal(inspection.prepare("PRAGMA synchronous").get().synchronous, 2);
      assert.notEqual(inspection.prepare("PRAGMA application_id").get().application_id, 0);
      assert.equal(inspection.prepare("PRAGMA user_version").get().user_version, 1);
    } finally {
      inspection.close();
    }
  });

  test("directory aliases share ownership and database hard links are rejected", (t) => {
    const path = fixture(t);
    const directory = resolve(path, "..");
    const alias = `${directory}-alias`;
    symlinkSync(directory, alias, process.platform === "win32" ? "junction" : "dir");
    cleanupOperations.get(t).push(() => rmSync(alias, { force: true }));
    const store = SqliteSchedulerStore.open(path);
    try {
      assert.throws(() => SqliteSchedulerStore.open(join(alias, "scheduler.sqlite")), /active owner/u);
    } finally {
      store.close();
    }
    linkSync(path, join(directory, "hard-link.sqlite"));
    assert.throws(() => SqliteSchedulerStore.open(path), /one filesystem link/u);
    assert.throws(() => SqliteSchedulerStore.open(join(directory, "hard-link.sqlite")), /one filesystem link/u);
  });

  test("rejects foreign, unsupported and corrupt databases and releases ownership after failed opens", (t) => {
    const directory = resolve(fixture(t), "..");
    const foreignPath = join(directory, "foreign.sqlite");
    const foreign = new DatabaseSync(foreignPath);
    foreign.exec("CREATE TABLE existing_data (value TEXT); INSERT INTO existing_data VALUES ('preserved')");
    foreign.close();
    assert.throws(() => SqliteSchedulerStore.open(foreignPath), /Unsupported scheduler database/u);
    const inspection = new DatabaseSync(foreignPath);
    try {
      assert.equal(inspection.prepare("SELECT value FROM existing_data").get().value, "preserved");
    } finally {
      inspection.close();
    }

    for (const [name, modification] of [
      ["future", "PRAGMA user_version = 2"],
      ["foreign-id", "PRAGMA application_id = 1"],
      ["unexpected-table", "CREATE TABLE unrelated (value TEXT)"],
    ]) {
      const path = join(directory, `${name}.sqlite`);
      SqliteSchedulerStore.open(path).close();
      const database = new DatabaseSync(path);
      database.exec(modification);
      database.close();
      assert.throws(() => SqliteSchedulerStore.open(path), /Unsupported scheduler database/u);
      assert.throws(() => SqliteSchedulerStore.open(path), /Unsupported scheduler database/u);
    }
    const garbagePath = join(directory, "garbage.sqlite");
    writeFileSync(garbagePath, "invalid database contents");
    assert.throws(() => SqliteSchedulerStore.open(garbagePath), /not a database/u);
    assert.throws(() => SqliteSchedulerStore.open(garbagePath), /not a database/u);
    for (const path of ["", ":memory:", "invalid\0path"])
      assert.throws(() => SqliteSchedulerStore.open(path), TypeError);
  });

  test("rejects corrupted records and foreign or multiply linked ownership databases", (t) => {
    const path = fixture(t);
    SqliteSchedulerStore.open(path).close();
    const corruption = new DatabaseSync(path);
    corruption.exec(
      "PRAGMA ignore_check_constraints = ON; INSERT INTO scheduler_records VALUES ('meta', 'corrupt', 'invalid JSON')",
    );
    corruption.close();
    assert.throws(() => SqliteSchedulerStore.open(path), /integrity validation failed/u);
    assert.throws(() => SqliteSchedulerStore.open(path), /integrity validation failed/u);

    const foreignPath = join(resolve(path, ".."), "foreign-lock.sqlite");
    const foreign = new DatabaseSync(`${foreignPath}.scheduler-lock.sqlite`);
    foreign.exec("CREATE TABLE unrelated (value TEXT)");
    foreign.close();
    assert.throws(() => SqliteSchedulerStore.open(foreignPath), /Unsupported scheduler ownership database/u);
    assert.throws(() => SqliteSchedulerStore.open(foreignPath), /Unsupported scheduler ownership database/u);

    const linkedPath = join(resolve(path, ".."), "linked-lock.sqlite");
    SqliteSchedulerStore.open(linkedPath).close();
    linkSync(`${linkedPath}.scheduler-lock.sqlite`, join(resolve(path, ".."), "ownership-alias.sqlite"));
    assert.throws(() => SqliteSchedulerStore.open(linkedPath), /ownership database must be a regular file/u);
  });

  test("enforces cross-process ownership and automatically recovers after process termination", async (t) => {
    const path = fixture(t);
    const child = await startOwner(t, path);
    assert.throws(() => SqliteSchedulerStore.open(path), /active owner/u);
    const exited = once(child, "exit");
    assert.equal(child.kill("SIGKILL"), true);
    await exited;
    const recovered = SqliteSchedulerStore.open(path);
    try {
      assert.deepEqual(recovered.get("meta", "committed"), { value: "preserved" });
    } finally {
      recovered.close();
    }
    const restarted = await startOwner(t, path);
    const restartedExit = once(restarted, "exit");
    restarted.kill("SIGKILL");
    await restartedExit;
    SqliteSchedulerStore.open(path).close();
  });

  test("process termination during a transaction preserves committed data and undoes unfinished writes", async (t) => {
    const path = fixture(t);
    const child = await startOwner(t, path, "--transaction");
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const recovered = SqliteSchedulerStore.open(path);
    try {
      assert.deepEqual(recovered.get("meta", "committed"), { value: "preserved" });
      assert.equal(recovered.get("meta", "uncommitted"), undefined);
      recovered.put("meta", "continued", true);
    } finally {
      recovered.close();
    }
  });
}

async function startOwner(t, path, mode) {
  const child = fork(fileURLToPath(import.meta.url), ["--owner", path, ...(mode ? [mode] : [])], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let diagnostics = "";
  child.stdout.on("data", (chunk) => {
    diagnostics += chunk;
  });
  child.stderr.on("data", (chunk) => {
    diagnostics += chunk;
  });
  cleanupOperations.get(t).push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  });
  await new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(
      () => rejectReady(new Error(`Child owner did not open scheduler storage: ${diagnostics}`)),
      10_000,
    );
    child.once("message", (message) => {
      clearTimeout(timeout);
      assert.equal(message.type, "ready");
      resolveReady();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectReady(error);
    });
    child.once("exit", () => {
      clearTimeout(timeout);
      rejectReady(new Error(`Child owner exited before readiness: ${diagnostics}`));
    });
  });
  return child;
}
