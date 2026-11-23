import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
export const LEAK_GUARD_URL = pathToFileURL(join(SCRIPTS_DIR, "test-leak-guard.mjs")).href;
export const DEFAULT_TEST_TIMEOUT_MS = 120_000;

export function buildNodeTestArgs(userArgs, env = process.env) {
  const args = ["--test", "--import", LEAK_GUARD_URL];
  const hasExplicitTimeout = userArgs.some((arg) => arg === "--test-timeout" || arg.startsWith("--test-timeout="));
  if (!hasExplicitTimeout) {
    const raw = env.MAY_TEST_TIMEOUT_MS;
    const timeoutMs = raw === undefined || raw === "" ? DEFAULT_TEST_TIMEOUT_MS : Number(raw);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new RangeError(`MAY_TEST_TIMEOUT_MS must be a positive safe integer, received: ${raw}`);
    }
    args.push(`--test-timeout=${timeoutMs}`);
  }
  args.push(...userArgs);
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href || process.argv[1]?.endsWith("run-node-tests.mjs")) {
  const args = buildNodeTestArgs(process.argv.slice(2));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, args, {
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  child.once("error", (error) => {
    console.error(error);
    process.exit(1);
  });
  child.once("exit", (code, signal) => {
    if (signal !== null) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}
