import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SqliteSchedulerStore } from "../dist/sqlite-store.js";
import { Scheduler } from "../dist/index.js";
import { DurableTaskHost } from "./fixtures/durable-host.mjs";

const fixtureRoot = fileURLToPath(new URL("../../../scheduler-verification/", import.meta.url));
const cleanupOperations = new WeakMap();

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
    assert.deepEqual(store.list("jobs").map((record) => record.value ?? record.count), ["first", 1]);
    assert.equal(store.get("events", "missing"), undefined);
    store.put("jobs", "a", { value: "updated" });
    store.delete("jobs", "b");
    store.delete("jobs", "missing");
    store.close();
    store.close();

    const reopened = SqliteSchedulerStore.open(path);
    try {
      assert.deepEqual(reopened.list("jobs"), [{ value: "updated" }]);
    } finally { reopened.close(); }
    assert.equal(existsSync(`${path}.scheduler-lock.sqlite`), true);
  });

  test("commits and rolls back multi-collection transactions and nested savepoints", (t) => {
    const store = SqliteSchedulerStore.open(fixture(t));
    cleanupOperations.get(t).push(() => store.close());
    assert.equal(store.transaction(() => {
      store.put("jobs", "job", { revision: 1 });
      store.transaction(() => store.put("executions", "execution", { status: "pending" }));
      return "committed";
    }), "committed");
    assert.deepEqual(store.get("executions", "execution"), { status: "pending" });

    assert.throws(() => store.transaction(() => {
      store.put("jobs", "job", { revision: 2 });
      store.put("events", "event", { topic: "created" });
      throw new Error("transaction validation failed");
    }), /transaction validation failed/u);
    assert.deepEqual(store.get("jobs", "job"), { revision: 1 });
    assert.equal(store.get("events", "event"), undefined);

    store.transaction(() => {
      assert.throws(() => store.transaction(() => {
        store.delete("jobs", "job");
        throw new Error("nested transaction failed");
      }), /nested transaction failed/u);
      store.put("meta", "sequence", 1);
    });
    assert.deepEqual(store.get("jobs", "job"), { revision: 1 });
    assert.equal(store.get("meta", "sequence"), 1);
  });

  test("rejects asynchronous transactions before they can write and rolls back Promise results", (t) => {
    const store = SqliteSchedulerStore.open(fixture(t));
    cleanupOperations.get(t).push(() => store.close());
    assert.throws(() => store.transaction(async () => {
      store.put("meta", "async", 1);
    }), /synchronous callback/u);
    assert.equal(store.get("meta", "async"), undefined);
    assert.throws(() => store.transaction(() => {
      store.put("meta", "promise", 1);
      return Promise.resolve();
    }), /cannot return a Promise/u);
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
    ]) assert.throws(operation, TypeError);
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
    ]) assert.throws(operation, /closed/u);
  });

  test("enforces the individual JSON record limit while allowing larger collection results", (t) => {
    const store = SqliteSchedulerStore.open(fixture(t));
    cleanupOperations.get(t).push(() => store.close());
    const maximum = "a".repeat(1024 * 1024 - 2);
    store.put("meta", "maximum", maximum);
    assert.equal(store.get("meta", "maximum").length, maximum.length);
    assert.throws(() => store.put("meta", "oversized", `${maximum}a`), RangeError);
    assert.equal(store.get("meta", "oversized"), undefined);
    assert.throws(() => store.transaction(() => {
      store.put("meta", "transaction", "pending");
      store.put("meta", "oversized", `${maximum}a`);
    }), RangeError);
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
    if (process.platform === "win32") assert.throws(() => SqliteSchedulerStore.open(path.toUpperCase()), /active owner/u);
    const inspection = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(inspection.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
      assert.equal(inspection.prepare("PRAGMA synchronous").get().synchronous, 2);
      assert.notEqual(inspection.prepare("PRAGMA application_id").get().application_id, 0);
      assert.equal(inspection.prepare("PRAGMA user_version").get().user_version, 1);
    } finally { inspection.close(); }
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
    } finally { store.close(); }
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
    try { assert.equal(inspection.prepare("SELECT value FROM existing_data").get().value, "preserved"); }
    finally { inspection.close(); }

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
    for (const path of ["", ":memory:", "invalid\0path"]) assert.throws(() => SqliteSchedulerStore.open(path), TypeError);
  });

  test("rejects corrupted records and foreign or multiply linked ownership databases", (t) => {
    const path = fixture(t);
    SqliteSchedulerStore.open(path).close();
    const corruption = new DatabaseSync(path);
    corruption.exec("PRAGMA ignore_check_constraints = ON; INSERT INTO scheduler_records VALUES ('meta', 'corrupt', 'invalid JSON')");
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
    try { assert.deepEqual(recovered.get("meta", "committed"), { value: "preserved" }); }
    finally { recovered.close(); }
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
    } finally { recovered.close(); }
  });

  test("job identifiers preserve the complete supported length in durable identity metadata", async (t) => {
    const { scheduler } = await schedulerFixture(t);
    for (const length of [252, 253, 256]) {
      const id = "a".repeat(length);
      const created = await scheduler.createJob({
        id,
        enabled: true,
        trigger: { type: "event", topic: "length-validation" },
        task: { handler: "write-artifact", payload: { length } },
        misfire: { policy: "latest", graceMs: 1_000 },
      });
      assert.equal(created.id, id);
    }
    assert.equal((await scheduler.listJobs()).length, 3);
  });

  test("an immediate stop drains the initial background round without reporting a failure", async (t) => {
    const errors = [];
    const { scheduler } = await schedulerFixture(t, { onError(error) { errors.push(error); } });
    const started = scheduler.start();
    const stopped = scheduler.stop();
    const outcomes = await Promise.allSettled([started, stopped]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status), ["fulfilled", "fulfilled"]);
    assert.deepEqual(errors, []);
    await scheduler.start();
    await scheduler.stop();
    assert.deepEqual(errors, []);
  });

  test("listing supported job payloads may return more than one individual record limit", async (t) => {
    const { scheduler, host } = await schedulerFixture(t);
    for (let index = 0; index < 20; index++) {
      await scheduler.createJob({
        id: `large-list-${index}`,
        enabled: true,
        trigger: { type: "event", topic: "large-list" },
        task: { handler: "write-artifact", payload: { text: "a".repeat(60_000) } },
        misfire: { policy: "latest", graceMs: 1_000 },
      });
    }
    const jobs = await scheduler.listJobs();
    assert.equal(jobs.length, 20);
    assert.ok(Buffer.byteLength(JSON.stringify(jobs)) > 1024 * 1024);
    const published = await scheduler.publish({
      source: "sqlite-store-tests",
      id: "large-execution-page",
      topic: "large-list",
      occurredAt: new Date().toISOString(),
      payload: {},
    });
    assert.equal(published.length, 20);
    const page = await scheduler.listExecutions({ limit: 20 });
    assert.equal(page.records.length, 20);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) > 1024 * 1024);
    assert.equal(host.tasks().length, 20);
    for (const task of host.tasks()) assert.equal(existsSync(task.artifact_path), true);
  });

  test("accepted ISO timestamp forms use the same parser during validation and persistence", async (t) => {
    const { scheduler } = await schedulerFixture(t);
    const created = await scheduler.createJob({
      id: "ordinal-timestamp",
      enabled: true,
      trigger: { type: "at", time: "2026-277T08:00:00+08:00" },
      task: { handler: "write-artifact", payload: {} },
      misfire: { policy: "latest", graceMs: 1_000 },
    });
    assert.equal(created.nextAt, "2026-10-04T00:00:00.000Z");
    assert.equal((await scheduler.listJobs()).length, 1);
  });

  test("the maximum supported payload depth survives time and event executions", async (t) => {
    const { scheduler, host } = await schedulerFixture(t);
    const payload = nestedPayload(60);
    const definition = {
      enabled: true,
      task: { handler: "write-artifact", payload },
      misfire: { policy: "latest", graceMs: 5_000 },
    };
    await scheduler.createJob({ ...definition, id: "depth-time", trigger: { type: "at", time: new Date(Date.now() - 100).toISOString() } });
    await scheduler.createJob({ ...definition, id: "depth-event", trigger: { type: "event", topic: "depth" } });
    assert.equal((await scheduler.listJobs()).length, 2);
    const [eventExecution] = await scheduler.publish({
      source: "sqlite-store-tests",
      id: "maximum-depth",
      topic: "depth",
      occurredAt: new Date().toISOString(),
      payload,
    });
    assert.equal(eventExecution.status, "submitted");
    assert.deepEqual(eventExecution.job.task.payload, payload);
    assert.deepEqual(eventExecution.event.payload, payload);
    assert.equal((await scheduler.tick()).submitted, 1);
    const page = await scheduler.listExecutions();
    assert.equal(page.records.length, 2);
    for (const record of page.records) {
      assert.equal(record.status, "submitted");
      assert.deepEqual(record.job.task.payload, payload);
    }
    assert.equal(host.tasks().length, 2);
  });

  test("oversized and deeply nested public inputs fail before changing scheduler storage", async (t) => {
    const { scheduler, host } = await schedulerFixture(t);
    const base = {
      id: "valid-boundaries",
      enabled: true,
      trigger: { type: "event", topic: "boundaries" },
      task: { handler: "write-artifact", payload: {} },
      misfire: { policy: "latest", graceMs: 1_000 },
    };
    const created = await scheduler.createJob(base);
    for (const payload of [nestedPayload(61), "a".repeat(64 * 1024 - 1)]) {
      await assert.rejects(scheduler.createJob({ ...base, id: "invalid-boundaries", task: { handler: "write-artifact", payload } }), RangeError);
      await assert.rejects(scheduler.updateJob(base.id, { task: { handler: "write-artifact", payload } }, created.revision), RangeError);
      await assert.rejects(scheduler.publish({ source: "sqlite-store-tests", id: "invalid-event", topic: "boundaries", occurredAt: new Date().toISOString(), payload }), RangeError);
      assert.equal((await scheduler.listJobs()).length, 1);
      assert.deepEqual((await scheduler.listExecutions()).records, []);
    }
    const [execution] = await scheduler.publish({ source: "sqlite-store-tests", id: "valid-event", topic: "boundaries", occurredAt: new Date().toISOString(), payload: {} });
    assert.equal(execution.status, "submitted");
    assert.equal(host.tasks().length, 1);
  });

  test("misfire policies require a supported string value", async (t) => {
    const { scheduler } = await schedulerFixture(t);
    await assert.rejects(scheduler.createJob({
      id: "invalid-policy",
      enabled: true,
      trigger: { type: "event", topic: "policies" },
      task: { handler: "write-artifact", payload: {} },
      misfire: { policy: ["latest"], graceMs: 1_000 },
    }), TypeError);
    assert.deepEqual(await scheduler.listJobs(), []);
  });

  test("reopening requires a next occurrence for every enabled cron job", async (t) => {
    const { scheduler, host, path } = await schedulerFixture(t);
    const job = await scheduler.createJob({
      id: "required-next-occurrence",
      enabled: true,
      trigger: { type: "cron", expression: "0 8 * * *", timezone: "Asia/Shanghai" },
      task: { handler: "write-artifact", payload: {} },
      misfire: { policy: "latest", graceMs: 1_000 },
    });
    assert.equal(typeof job.nextAt, "string");
    await scheduler.close();
    const store = SqliteSchedulerStore.open(path);
    cleanupOperations.get(t).push(() => store.close());
    const { nextAt, ...withoutNext } = job;
    store.put("jobs", job.id, withoutNext);
    assert.throws(() => Scheduler.open({ store, dispatcher: host }), /nextAt|occurrence/u);
  });
}

function fixture(t) {
  mkdirSync(fixtureRoot, { recursive: true });
  const directory = mkdtempSync(join(fixtureRoot, "sqlite-store-"));
  const operations = [];
  cleanupOperations.set(t, operations);
  t.after(async () => {
    for (const cleanup of operations.reverse()) await cleanup();
    rmSync(directory, { recursive: true, force: true });
  });
  return join(directory, "scheduler.sqlite");
}

async function startOwner(t, path, mode) {
  const child = fork(fileURLToPath(import.meta.url), ["--owner", path, ...(mode ? [mode] : [])], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let diagnostics = "";
  child.stdout.on("data", (chunk) => { diagnostics += chunk; });
  child.stderr.on("data", (chunk) => { diagnostics += chunk; });
  cleanupOperations.get(t).push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  });
  await new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error(`Child owner did not open scheduler storage: ${diagnostics}`)), 10_000);
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

async function schedulerFixture(t, options = {}) {
  const path = fixture(t);
  const store = SqliteSchedulerStore.open(path);
  cleanupOperations.get(t).push(() => store.close());
  const host = await DurableTaskHost.open(join(resolve(path, ".."), "host"));
  cleanupOperations.get(t).push(() => host.close());
  const scheduler = Scheduler.open({ store, dispatcher: host, ...options });
  cleanupOperations.get(t).push(() => scheduler.close());
  return { scheduler, store, host, path };
}

function nestedPayload(depth) {
  let payload = "leaf";
  for (let index = 0; index < depth; index++) payload = { child: payload };
  return payload;
}
