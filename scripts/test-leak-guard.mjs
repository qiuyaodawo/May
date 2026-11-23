import { writeSync } from "node:fs";
import { after } from "node:test";

const DEFAULT_LEAK_GRACE_MS = 5_000;

export function parseLeakGraceMs(env = process.env) {
  const raw = env.MAY_TEST_LEAK_GRACE_MS;
  if (raw === undefined || raw === "") return DEFAULT_LEAK_GRACE_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RangeError(`MAY_TEST_LEAK_GRACE_MS must be a positive safe integer, received: ${raw}`);
  }
  return parsed;
}

export function formatLeakMessage({ file, graceMs, handles }) {
  return (
    `\n[test-leak-guard] Test worker did not exit within ${graceMs}ms after all tests completed.\n` +
    `  File: ${file}\n` +
    `  Active handles keeping the event loop alive: ${JSON.stringify(handles)}\n` +
    `  Fix: close HTTP servers (use closeServer()/trackServer() from "@sortedyuan/test-support"), ` +
    `child processes, timers, or workspaces in finally / t.after().\n`
  );
}

const context = process.env.NODE_TEST_CONTEXT;
const activeInProcess = context === "child-v8" || context === "child" || process.env.MAY_TEST_LEAK_GUARD === "1";

if (activeInProcess) {
  let armed = false;
  after(() => {
    if (armed) return;
    armed = true;
    const graceMs = parseLeakGraceMs();
    const timer = setTimeout(() => {
      const handles =
        typeof process.getActiveResourcesInfo === "function" ? process.getActiveResourcesInfo() : ["unknown"];
      const file = process.argv[1] || "<unknown test file>";
      writeSync(2, formatLeakMessage({ file, graceMs, handles }));
      process.exit(1);
    }, graceMs);
    timer.unref();
  });
}
