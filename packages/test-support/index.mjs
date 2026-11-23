import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import fc from "fast-check";

export { fc };

/**
 * Default iteration count for property-based tests.
 * Override with `MAY_PBT_RUNS` (for example in `pnpm test:fuzz`).
 */
export function pbtRuns(defaultRuns = 100) {
  const raw = process.env.MAY_PBT_RUNS;
  if (raw === undefined || raw === "") return defaultRuns;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RangeError(`MAY_PBT_RUNS must be a positive safe integer, received: ${raw}`);
  }
  return parsed;
}

/** Ignored root for all repository test data. Respects `MAY_TEST_OUTPUT_ROOT` for path-alias testing. */
export const testOutputRoot =
  process.env.MAY_TEST_OUTPUT_ROOT || fileURLToPath(new URL("../../.test-output/", import.meta.url));

/** Model profile for tests that call a real provider: `MAY_LIVE_MODEL`, otherwise the configured `defaultModel`. */
export function selectLiveModelProfile(config) {
  const profile = process.env.MAY_LIVE_MODEL || config.defaultModel;
  if (profile === undefined) throw new Error(`Set MAY_LIVE_MODEL or defaultModel in ${config.path}`);
  if (!Object.hasOwn(config.models, profile))
    throw new Error(`Model profile "${profile}" is not configured in ${config.path}`);
  return profile;
}

/**
 * Create `<repository>/.test-output/<name>-XXXXXX` for one test and remove it after the test.
 * `name` usually starts with the package, for example `coordination/pricing`.
 */
export async function createTestDirectory(t, name) {
  const prefix = join(testOutputRoot, name);
  await mkdir(join(prefix, ".."), { recursive: true });
  const directory = await mkdtemp(`${prefix}-`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * Close an HTTP/Net server cleanly, terminating keep-alive connections so the
 * test worker exits promptly without leaking a listening TCPServerWrap handle.
 */
export async function closeServer(server) {
  if (!server) return;
  if (typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    });
  });
}

/**
 * Bind an HTTP/Net server to `t.after(...)` so it is always closed when the test ends.
 */
export function trackServer(t, server) {
  t.after(() => closeServer(server));
  return server;
}

/**
 * Check `probe` every 10 ms until it returns a truthy value, and return that value.
 * The wait has no deadline of its own: the test's `timeout` option ends a condition that is never reached,
 * and the wait stops when the test context `t` is cancelled.
 */
export async function until(t, probe, describe) {
  try {
    for (;;) {
      t.signal.throwIfAborted();
      const value = await probe();
      if (value) return value;
      await delay(10, undefined, { signal: t.signal });
    }
  } finally {
    if (t.signal.aborted && describe) t.diagnostic(describe());
  }
}
