import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_TASK_BUDGET, FileTaskStore, MaybeClaw, digest, runMaybeClaw, taskId } from "../dist/index.js";

const assistant = (text, toolCalls) => ({ role: "assistant", content: [{ type: "text", text }], ...(toolCalls ? { toolCalls } : {}) });
const usage = { inputTokens: 20, outputTokens: 5, totalTokens: 25 };
const finished = (text) => ({ type: "response.completed", message: assistant(text), usage });

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "maybeclaw-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "state");
  const readDirectory = join(root, "source");
  await mkdir(readDirectory);
  await writeFile(join(readDirectory, "notes.txt"), "The project uses TypeScript.");
  const spec = { requestId: "request-1", prompt: "Read notes.txt and summarize it.", configPath: join(root, "config.json"),
    modelProfile: "fixture", modelFingerprint: digest("fixture"), readDirectory, runBudget: DEFAULT_TASK_BUDGET };
  return { root, directory, readDirectory, spec };
}

test("task round trip uses May tools, deduplicates, and recovers a missing completion projection without replay", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const claw = new MaybeClaw({ directory: f.directory, loadModel: () => ({ async *stream(request) {
    calls++;
    assert.deepEqual(request.tools.map((tool) => tool.name), ["read"]);
    const output = request.messages.find((message) => message.role === "tool");
    if (!output) yield { type: "response.completed", message: assistant("", [{ id: "read-1", name: "read", input: { path: "notes.txt" } }]), usage };
    else { assert.match(JSON.stringify(output), /TypeScript/); yield finished("The project uses TypeScript."); }
  } }) });
  const { task, created } = await claw.submit(f.spec);
  assert.equal(created, true);
  assert.equal((await claw.submit(f.spec)).created, false);
  await assert.rejects(claw.submit({ ...f.spec, prompt: "different" }), /different task specification/);
  const result = await claw.run(task.id);
  assert.equal(result.status, "completed");
  assert.equal(result.verification, "unverified");
  assert.match(result.result, /TypeScript/);
  assert.equal(calls, 2);

  const reopened = new MaybeClaw({ directory: f.directory, loadModel: () => { throw new Error("Must not load a model"); } });
  assert.deepEqual(await reopened.run(task.id), result);
  assert.equal((await reopened.store.list()).length, 1);
  // Crash window: Session terminal record is durable; final task projection is absent.
  const path = claw.store.path(task.id, "jsonl");
  const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
  await writeFile(path, lines.slice(0, -1).join("\n") + "\n");
  assert.equal((await reopened.status(task.id)).task.status, "running");
  assert.equal((await reopened.recover(task.id)).result, result.result);
  assert.equal(calls, 2);
});

test("queued and active cancellation are durable, and a second owner cannot execute the same task", async (t) => {
  const f = await fixture(t);
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const claw = new MaybeClaw({ directory: f.directory, loadModel: () => ({ async *stream(_request, { signal }) {
    started();
    if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    signal.throwIfAborted();
  } }) });
  const other = new MaybeClaw({ directory: f.directory, loadModel: () => { throw new Error("Unexpected execution"); } });
  const queued = (await claw.submit({ ...f.spec, requestId: "queued" })).task;
  assert.equal((await other.cancel(queued.id)).task.status, "cancelled");
  assert.equal((await other.run(queued.id)).status, "cancelled");
  const active = (await claw.submit(f.spec)).task;
  const running = claw.run(active.id);
  await ready;
  await assert.rejects(other.run(active.id), /locked/);
  assert.equal((await other.submit(f.spec)).created, false);
  await other.cancel(active.id);
  assert.equal((await running).status, "cancelled");
  assert.equal((await other.status(active.id)).owner, null);
});

test("crashed process leaves an explicit lock and submitted input is never replayed by recovery", async (t) => {
  const f = await fixture(t);
  const claw = new MaybeClaw({ directory: f.directory, loadModel: () => { throw new Error("No replay"); } });
  const { task } = await claw.submit(f.spec);
  const moduleUrl = new URL("../dist/index.js", import.meta.url).href;
  const script = `import { MaybeClaw } from ${JSON.stringify(moduleUrl)};
    const claw = new MaybeClaw({ directory: ${JSON.stringify(f.directory)}, loadModel: () => ({ async *stream() {
      process.stdout.write('MODEL_STARTED\\n'); await new Promise(() => {});
    } }) }); await claw.run(${JSON.stringify(task.id)});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const exit = once(child, "exit");
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child did not start: ${stderr}`)), 10_000);
    child.stdout.on("data", (chunk) => { if (chunk.toString().includes("MODEL_STARTED")) { clearTimeout(timer); resolve(); } });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(`child exited: ${stderr}`)); });
  });
  child.kill("SIGKILL"); await exit;
  await assert.rejects(claw.recover(task.id), /locked/);
  // Explicit host recovery only after the actual owner process has exited.
  await unlink(claw.store.path(task.id, "lock"));
  assert.equal((await claw.recover(task.id)).status, "blocked");
  assert.equal((await claw.run(task.id)).status, "blocked");
  assert.equal((await claw.cancel(task.id)).task.status, "blocked");
});

test("journal ownership, tail repair and missing execution evidence fail closed", async (t) => {
  const f = await fixture(t);
  const claw = new MaybeClaw({ directory: f.directory, loadModel: () => { throw new Error("No replay"); } });
  const { task } = await claw.submit(f.spec);
  const path = claw.store.path(task.id, "jsonl");
  await appendFile(path, '{"incomplete":');
  const before = await readFile(path);
  assert.equal((await claw.status(task.id)).task.status, "queued");
  assert.deepEqual(await readFile(path), before);
  const journal = await claw.store.acquire(task.id);
  await journal.write({ ...task, revision: 2, updatedAt: task.updatedAt, status: "running" });
  await journal.close();
  // Missing history after dispatch intent is not proof of non-execution.
  assert.equal((await claw.recover(task.id)).status, "blocked");
  await appendFile(path, '{"bad":true}\n');
  await assert.rejects(claw.recover(task.id), /Invalid task journal record/);
  await assert.rejects(claw.submit({ ...f.spec, requestId: "overlap", readDirectory: f.root }), /overlap/);
  await assert.rejects(claw.status("../escape"), /Invalid MaybeClaw task id/);
});

test("CLI executes the real provider adapter against a local fixture and queries without credentials", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); calls++;
    assert.equal(body.model, "local-fixture");
    assert.equal(body.tools?.length ?? 0, 0);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Fixture response." }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const config = { providers: { local: { adapter: "openai-chat-completions", apiKey: "fixture-only-key",
    baseURL: `http://127.0.0.1:${server.address().port}/v1` } }, models: { fixture: { provider: "local", model: "local-fixture" } }, defaultModel: "fixture" };
  await writeFile(f.spec.configPath, JSON.stringify(config));
  let output = ""; let error = "";
  const deps = { stdout: { write: (s) => { output += s; } }, stderr: { write: (s) => { error += s; } } };
  assert.equal(await runMaybeClaw(["task", "submit", "Say hello", "--request-id", "cli", "--config", f.spec.configPath, "--data-directory", f.directory], deps), 0, error);
  assert.match(output, /Fixture response/);
  assert.equal(calls, 1);
  const id = taskId("cli");
  assert.doesNotMatch(await readFile(new FileTaskStore(f.directory).path(id, "jsonl"), "utf8"), /fixture-only-key/);
  await unlink(f.spec.configPath);
  output = "";
  for (const action of ["status", "result", "run", "recover"]) {
    assert.equal(await runMaybeClaw(["task", action, id, "--data-directory", f.directory], deps), 0, error);
  }
  assert.equal(calls, 1);
  assert.equal(await runMaybeClaw(["task", "run", id, "--model", "other"], deps), 2);
  assert.equal(await runMaybeClaw(["task", "submit", "a", "b"], deps), 2);
});

test("queued configuration bindings and budgets are checked before model creation", async (t) => {
  const f = await fixture(t);
  let modelLoads = 0;
  const config = { path: f.spec.configPath, providers: { local: { adapter: "openai-chat-completions", apiKey: "test" } },
    models: { fixture: { provider: "local", model: "before" } }, defaultModel: "fixture" };
  let error = "";
  const deps = { loadConfig: async () => config, createModel: () => { modelLoads++; return { async *stream() { yield finished("ok"); } }; },
    stdout: { write() {} }, stderr: { write(s) { error += s; } } };
  const common = ["--data-directory", f.directory];
  assert.equal(await runMaybeClaw(["task", "submit", "hello", "--request-id", "pinned", "--enqueue", ...common], deps), 0);
  config.models.fixture.model = "after";
  assert.equal(await runMaybeClaw(["task", "run", taskId("pinned"), ...common], deps), 1);
  assert.match(error, /configuration changed/); assert.equal(modelLoads, 0);
  config.models.fixture.model = "before";
  config.apps = { maybeclaw: { runBudget: { maxSteps: 1 } } };
  assert.equal(await runMaybeClaw(["task", "run", taskId("pinned"), ...common], deps), 1);
  assert.equal(modelLoads, 0);
  delete config.apps;
  assert.equal(await runMaybeClaw(["task", "run", taskId("pinned"), ...common], deps), 0, error);
  assert.equal(modelLoads, 1);
});
