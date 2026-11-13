import assert from "node:assert/strict";
import { testOutputRoot } from "@sortedyuan/test-support";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Scheduler } from "../../dist/index.js";
import { SqliteSchedulerStore } from "../../dist/sqlite-store.js";
import { DurableTaskHost } from "./durable-host.mjs";

export const verificationRoot = join(testOutputRoot, "scheduler", "verification");

export async function directory(name) {
  await mkdir(verificationRoot, { recursive: true });
  return mkdtemp(join(verificationRoot, `${name}-`));
}

export async function setup(t, name, options = {}) {
  const path = await directory(name);
  const host = await DurableTaskHost.open(join(path, "host"), options);
  const store = await SqliteSchedulerStore.open(join(path, "scheduler.sqlite"));
  const backgroundErrors = [];
  const scheduler = await Scheduler.open({
    store,
    dispatcher: host,
    maxConcurrentSubmissions: options.maxConcurrentSubmissions,
    onError:
      options.onError ??
      ((error) => {
        backgroundErrors.push(error);
      }),
  });
  t.after(async () => {
    await scheduler.close();
    await host.close();
    assert.deepEqual(backgroundErrors, []);
  });
  return { path, scheduler, host, store };
}

export function job(id, trigger, options = {}) {
  return {
    id,
    enabled: true,
    trigger,
    task: { handler: "write-artifact", payload: { label: id } },
    misfire: { policy: "latest", graceMs: 60_000 },
    ...options,
  };
}

export function event(id, topic = "tasks") {
  return {
    source: "scheduler-test",
    id,
    topic,
    occurredAt: new Date().toISOString(),
    payload: { label: id },
  };
}

export async function waitUntil(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("The operation did not finish before the deadline.");
    await delay(10);
  }
}
