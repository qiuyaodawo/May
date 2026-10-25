import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AgentApplication } from "../../application/dist/index.js";
import { recoverFileLock } from "../../file-storage/dist/index.js";
import { OpenAIChatCompletionsModel } from "../../providers/openai-compatible/dist/index.js";
import { FileSessionStore } from "../../session/dist/file-store.js";
import { inspectSessionRunOutcome } from "../../session/dist/index.js";
import { CoordinationRuntime, createAttachedApplicationAgent } from "../dist/index.js";
import { FileCoordinationStore } from "../dist/file-store.js";

for (const [boundary, expected] of [["continuation.submitted", "recovery-required"], ["run.cancelled", "cancelled"], ["run.failed", "failed"]]) {
  test(`attached continuation recovers after process exit at ${boundary}`, async t => {
    const base = fileURLToPath(new URL("../../../review/architecture-fix-20261023/coordination/", import.meta.url));
    await mkdir(base, { recursive: true });
    const directory = await mkdtemp(join(base, "interrupted-"));
    assert.ok(directory.startsWith(base));
    let application;
    let resumed;
    t.after(async () => {
      await resumed?.close();
      await application?.close();
      await rm(directory, { recursive: true, force: true });
    });
    const fixture = fileURLToPath(new URL("./fixtures/attached-continuation-crash.mjs", import.meta.url));
    const child = spawnSync(process.execPath, [fixture, directory, boundary], { encoding: "utf8", timeout: 15000 });
    assert.equal(child.status, 23, child.stderr);
    const store = new FileCoordinationStore(join(directory, "coordination"));
    const interrupted = await store.inspect("attached-recovery");
    assert.equal(interrupted.tasks[0].status, "running");
    assert.equal(interrupted.tasks[0].recoveryVersion, 1);
    const sessions = new FileSessionStore(join(directory, "sessions"));
    const history = await sessions.inspect("attached-root");
    assert.equal(history.at(-1).type, boundary);
    const continuationId = `${interrupted.tasks[0].dispatchId}:0`;
    assert.equal(inspectSessionRunOutcome(history, { continuationId }).status, expected);
    const lockPath = join(directory, "coordination", `${Buffer.from("attached-recovery").toString("base64url")}.lock`);
    await recoverFileLock(lockPath, { expectedContents: await readFile(lockPath, "utf8"), confirmHostsStopped: true });
    application = await AgentApplication.open({ sessionId: "attached-root", resume: true, store: sessions,
      model: new OpenAIChatCompletionsModel({ apiKey: "unused-during-recovery", model: "gpt-4o" }),
    });
    const worker = createAttachedApplicationAgent({ version: "v1", mode: "continue", attach: () => application,
      read: sessionId => sessions.inspect(sessionId), submit: () => ({ input: "Continue" }),
    });
    resumed = await CoordinationRuntime.resume({ id: "attached-recovery", store, agents: { worker },
      policy: { version: "v1", authorize: () => true },
    });
    assert.equal((await resumed.wait()).tasks[0].status, expected);
    assert.deepEqual(await sessions.inspect("attached-root"), history);
  });
}
