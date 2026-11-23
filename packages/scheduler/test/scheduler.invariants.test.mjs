import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { fc, pbtRuns } from "@sortedyuan/test-support";
import { latestTime, nextTime } from "../dist/triggers.js";
import { event, job, setup } from "./fixtures/scheduler-setup.mjs";

const TIMEZONES = ["UTC", "Asia/Shanghai", "America/New_York", "Europe/London", "Australia/Sydney"];
const CRONS = ["0 * * * *", "30 2 * * *", "15 1 * * *", "0 8 * * 1-5", "*/15 * * * *"];
// Timestamps spanning DST transitions (spring forward & fall back across 2025-2027)
const ANCHOR_MIN = Date.parse("2025-03-01T00:00:00Z");
const ANCHOR_MAX = Date.parse("2027-11-30T23:59:00Z");

test("invariant: nextTime is strictly monotonic and consistent with latestTime across IANA timezones & DST", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...TIMEZONES),
      fc.constantFrom(...CRONS),
      fc.integer({ min: ANCHOR_MIN, max: ANCHOR_MAX }),
      (timezone, expression, afterMs) => {
        const trigger = { type: "cron", expression, timezone };
        const firstIso = nextTime(trigger, afterMs);
        assert.ok(firstIso !== undefined);
        const firstMs = Date.parse(firstIso);
        assert.ok(
          firstMs > afterMs,
          `nextTime (${firstIso}) must be strictly > after (${new Date(afterMs).toISOString()})`,
        );

        assert.equal(latestTime(trigger, afterMs, firstMs), firstIso);
        if (firstMs - 1 >= afterMs) {
          assert.equal(latestTime(trigger, afterMs, firstMs - 1), undefined);
        }

        const secondIso = nextTime(trigger, firstMs);
        assert.ok(secondIso !== undefined);
        assert.ok(Date.parse(secondIso) > firstMs, "consecutive cron occurrences must strictly increase");
      },
    ),
    { numRuns: pbtRuns(150) },
  );
});

test("invariant: concurrent duplicate event publish and ticks dispatch each (job, event) at most once", async (t) => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 3 }),
      fc.array(fc.constantFrom("ev-a", "ev-b", "ev-c", "ev-d"), { minLength: 1, maxLength: 6 }),
      fc.integer({ min: 2, max: 5 }),
      async (jobCount, eventIds, concurrency) => {
        const cleanups = [];
        const iterT = {
          after: (fn) => cleanups.push(fn),
          signal: t.signal,
        };
        const { path: dir, scheduler, host } = await setup(iterT, "pbt-idempotency");
        try {
          for (let j = 0; j < jobCount; j += 1) {
            await scheduler.createJob(job(`job-${j}`, { type: "event", topic: "tasks" }));
          }

          const eventsById = new Map();
          for (const id of eventIds) {
            const payload = eventsById.get(id) ?? event(id);
            eventsById.set(id, payload);
            const results = await Promise.all(Array.from({ length: concurrency }, () => scheduler.publish(payload)));
            for (const records of results) {
              assert.deepEqual(
                records.map((r) => r.id),
                results[0].map((r) => r.id),
                "concurrent duplicate publishes must converge to identical execution ids",
              );
            }
          }

          await Promise.all(Array.from({ length: concurrency }, () => scheduler.tick()));
          const uniqueEvents = new Set(eventIds).size;
          const expectedDispatches = uniqueEvents * jobCount;
          const records = (await scheduler.listExecutions({ limit: 100 })).records;

          assert.equal(records.length, expectedDispatches);
          assert.equal(host.tasks().length, expectedDispatches);
          assert.deepEqual(
            records.map((r) => r.seq).sort((a, b) => a - b),
            Array.from({ length: records.length }, (_, i) => i + 1),
          );
          assert.ok(records.every((r) => r.status === "submitted"));
        } finally {
          for (const cleanup of cleanups.reverse()) {
            await cleanup();
          }
          await rm(dir, { recursive: true, force: true });
        }
      },
    ),
    { numRuns: pbtRuns(20) },
  );
});
