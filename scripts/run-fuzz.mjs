import { spawn } from "node:child_process";
import { buildNodeTestArgs } from "./run-node-tests.mjs";

const INVARIANT_TESTS = [
  "packages/tools/coding-tools/test/workspace-path.invariants.test.mjs",
  "packages/may/test/core/runtime-session.invariants.test.mjs",
  "packages/may/test/permissions/executor.invariants.test.mjs",
  "packages/coordination/test/shared-budget.invariants.test.mjs",
  "packages/scheduler/test/scheduler.invariants.test.mjs",
  "packages/providers/test/stream-retry.invariants.test.mjs",
];

const runs = process.env.MAY_PBT_RUNS || "500";
const child = spawn(process.execPath, buildNodeTestArgs(INVARIANT_TESTS), {
  stdio: "inherit",
  env: { ...process.env, MAY_PBT_RUNS: runs },
  windowsHide: true,
});
child.once("error", (error) => {
  console.error(error);
  process.exit(1);
});
child.once("exit", (code) => {
  process.exit(code ?? 1);
});
