import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createWorkspace(t) {
  const path = await mkdtemp(join(tmpdir(), "may-coding-tools-"));
  t.after(() => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return path;
}

export async function executeTool(tool, input, signal, report = () => {}) {
  const parsed = tool.parse ? tool.parse(input) : input;
  return tool.execute(parsed, {
    runId: "run_test",
    step: 1,
    toolCallId: "call_test",
    idempotencyKey: "run_test:1:call_test",
    signal: signal ?? new AbortController().signal,
    report,
  });
}

export function assertErrorCode(expected) {
  return (error) => {
    if (!(error instanceof Error) || error.code !== expected) return false;
    return true;
  };
}
