import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BasicTracer, DiagnosticsStore } from "../../observability/dist/index.js";
import { CoordinationRuntime, InMemoryCoordinationStore } from "../dist/index.js";
import { createRemoteAgent } from "../dist/remote-worker.js";

test("independent HTTP worker preserves trace parents and rejects invalid correlation without new execution", { timeout: 15_000 }, async t => {
  const parentDirectory = fileURLToPath(new URL("../../../review/correlation-tests/", import.meta.url));
  await mkdir(parentDirectory, { recursive: true });
  const directory = await mkdtemp(join(parentDirectory, "worker-"));
  let modelCalls = 0;
  const service = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    modelCalls += 1;
    const content = body.messages.at(-1).content;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: "stop" }],
      usage: { prompt_tokens: body.messages.length, completion_tokens: content.length, total_tokens: body.messages.length + content.length } })}\n\ndata: [DONE]\n\n`);
  });
  service.listen(0, "127.0.0.1");
  await once(service, "listening");
  const token = randomUUID() + randomUUID();
  const child = spawn(process.execPath, [fileURLToPath(new URL("fixtures/correlated-http-worker.mjs", import.meta.url)), directory,
    `http://127.0.0.1:${service.address().port}`], { env: { ...process.env, MAY_CORRELATION_WORKER_TOKEN: token }, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr.on("data", bytes => { stderr += bytes.toString(); });
  const exited = once(child, "exit");
  let runtime;
  t.after(async () => {
    await runtime?.close();
    if (child.connected) child.send("close");
    const timer = setTimeout(() => child.kill(), 5_000);
    try { assert.equal((await exited)[0], 0, stderr); }
    finally { clearTimeout(timer); service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); await rm(directory, { recursive: true, force: true }); }
  });
  const [ready] = await once(child, "message", { signal: AbortSignal.timeout(5_000) });
  assert.equal(ready.type, "ready");
  const url = `http://127.0.0.1:${ready.port}`;
  const remote = createRemoteAgent({ url, token, agent: "worker", version: "v1", pollIntervalMs: 10, requestTimeoutMs: 2_000 });
  const diagnostics = new DiagnosticsStore();
  const tracer = new BasicTracer({ processor: diagnostics, observer: diagnostics });
  const parent = tracer.startSpan("host.remote");
  runtime = await CoordinationRuntime.create({ id: "remote-correlation", store: new InMemoryCoordinationStore(), tracer,
    telemetry: { version: 1, parent: parent.context, schedulerExecutionId: "scheduled-execution" },
    agents: { remote }, policy: { version: "v1", authorize: () => true }, tasks: [{ id: "remote-task", agent: "remote", input: "remote-task" }] });
  const state = await runtime.wait();
  assert.equal(state.tasks[0].status, "completed", state.tasks[0].detail);
  assert.equal(modelCalls, 1);
  const dispatch = diagnostics.getDiagnostics({ taskId: "remote-task" }).spans.find(span => span.name === "may.coordination.dispatch");
  child.send("diagnostics");
  const [message] = await once(child, "message", { signal: AbortSignal.timeout(2_000) });
  assert.equal(message.type, "diagnostics");
  const run = message.value.spans.find(span => span.name === "may.run");
  assert.equal(run.parentSpanId, dispatch.context.spanId);
  assert.equal(run.context.traceId, parent.context.traceId);
  assert.equal(run.attributes["may.scheduler.execution_id"], "scheduled-execution");
  assert.equal(run.attributes["may.task.id"], "remote-task");
  assert.equal(run.attributes["may.dispatch.id"], state.tasks[0].dispatchId);
  const execution = { coordinationId: state.id, task: state.tasks[0], dependencies: [], messages: [],
    telemetry: { version: 1, taskId: "remote-task", parent: { ...parent.context, spanId: "1234567890abcdef" } } };
  const repeated = await fetch(`${url}/v1/jobs`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ agent: "worker", execution }) });
  assert.equal(repeated.status, 200);
  await repeated.body.cancel();
  const rejected = await fetch(`${url}/v1/jobs`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ agent: "worker", execution: { ...execution, telemetry: { version: 2, parent: parent.context } } }) });
  assert.equal(rejected.status, 400);
  await rejected.body.cancel();
  for (const field of ["taskId", "coordinationId", "dispatchId"]) {
    const conflicting = await fetch(`${url}/v1/jobs`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ agent: "worker", execution: { ...execution, telemetry: { ...execution.telemetry, [field]: "unrelated-identity" } } }) });
    assert.equal(conflicting.status, 400, `${field} must match the execution`);
    await conflicting.body.cancel();
  }
  assert.equal(modelCalls, 1);
  parent.end({ status: "ok" });
});
