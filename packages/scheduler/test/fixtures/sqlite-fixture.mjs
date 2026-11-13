import { testOutputRoot } from "@sortedyuan/test-support";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

export const fixtureRoot = join(testOutputRoot, "scheduler", "verification");
export const cleanupOperations = new WeakMap();

export function fixture(t) {
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
