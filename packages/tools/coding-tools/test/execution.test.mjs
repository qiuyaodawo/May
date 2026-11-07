import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { openCodingExecutionEnvironment } from "../dist/execution.js";

async function workspace(t) {
  const base = fileURLToPath(new URL("../../../../review/impl-batch-b/execution", import.meta.url));
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "workspace-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("host environment runs a real process and rejects cwd outside workspace", async (t) => {
  const cwd = await workspace(t);
  const environment = await openCodingExecutionEnvironment({ workspace: cwd, isolation: { mode: "host" } });
  t.after(() => environment.close());
  const child = environment.spawn(process.execPath, ["-e", "process.stdout.write(process.cwd())"], {
    cwd,
    signal: new AbortController().signal,
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  assert.equal((await once(child, "close"))[0], 0);
  assert.equal(output.toLowerCase(), cwd.toLowerCase());
  assert.throws(
    () => environment.spawn(process.execPath, [], { cwd: resolve(cwd, ".."), signal: new AbortController().signal }),
    { code: "CODING_TOOL_PATH_OUTSIDE_WORKSPACE" },
  );
});

test("host cancellation waits for a real running process to exit", async (t) => {
  const cwd = await workspace(t);
  const environment = await openCodingExecutionEnvironment({ workspace: cwd, isolation: { mode: "host" } });
  t.after(() => environment.close());
  const controller = new AbortController();
  const child = environment.spawn(process.execPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"], {
    cwd,
    signal: controller.signal,
  });
  await once(child.stdout, "data");
  const exited = once(child, "close");
  controller.abort();
  await exited;
  await environment.close();
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
});

test("host close terminates running processes and rejects subsequent spawn", async (t) => {
  const cwd = await workspace(t);
  const environment = await openCodingExecutionEnvironment({ workspace: cwd, isolation: { mode: "host" } });
  const child = environment.spawn(process.execPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"], {
    cwd,
    signal: new AbortController().signal,
  });
  await once(child.stdout, "data");
  await environment.close();
  await environment.close();
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  assert.throws(() => environment.spawn(process.execPath, [], { cwd, signal: new AbortController().signal }), {
    code: "CODING_EXECUTION_CLOSED",
  });
});
