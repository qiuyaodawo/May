import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { CoordinationWorker, createRemoteAgent } from "@may/coordination/remote";
import { createGatewayRpcAdapter } from "@may/plugin-agent-adapters/rpc";

const parent = fileURLToPath(new URL("../../../../review/worker-cancellation/", import.meta.url));
const example = fileURLToPath(new URL("../../../../packages/plugins/agent-adapters/examples/rpc-file-agent.mjs", import.meta.url));

export async function until(probe) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await probe()) return; await delay(10); }
  throw new Error("等待真实组件状态超时");
}

export async function fixture(t, { disconnectOnAbort = false, cancelSupported = true } = {}) {
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "worker-"));
  const stateDirectory = join(directory, "rpc-state");
  const pipe = process.platform === "win32" ? `\\\\.\\pipe\\may-test-${randomUUID()}` : join(directory, "rpc.socket");
  const child = spawn(process.execPath, [example, "--directory", stateDirectory, "--workspace", directory,
    "--socket", pipe, ...(cancelSupported ? [] : ["--no-cancel"])], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  const childExit = once(child, "exit");
  const sockets = new Set();
  const disconnect = () => { for (const socket of sockets) socket.destroy(); };
  const proxy = createTcpServer(client => {
    const backend = connect(pipe);
    for (const socket of [client, backend]) {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => { client.destroy(); backend.destroy(); });
    }
    client.pipe(backend); backend.pipe(client);
  });
  let rpc, worker, server, port;
  t.after(async () => {
    await worker?.close();
    if (server?.listening) { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    await rpc?.close();
    disconnect();
    if (proxy.listening) await new Promise((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
    if (child.exitCode === null) child.kill();
    await childExit;
    assert.equal(stderr, "");
    await rm(directory, { recursive: true, force: true });
  });
  await until(() => new Promise(resolve => {
    const socket = connect(pipe);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  }));
  async function startProxy() {
    proxy.listen(port ?? 0, "127.0.0.1"); await once(proxy, "listening"); port = proxy.address().port;
  }
  async function stopProxy() {
    disconnect(); await new Promise((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
  }
  await startProxy();
  rpc = await createGatewayRpcAdapter("files", { transport: "socket", host: "127.0.0.1", port, timeoutMs: 500 });
  const token = randomBytes(32).toString("hex");
  const controlPath = join(directory, "controls.jsonl");
  const bridge = {
    version: "1",
    async execute(execution, context) {
      if (disconnectOnAbort) context.signal.addEventListener("abort", disconnect, { once: true });
      try {
        return await rpc.execute({ conversationId: execution.task.sessionId, inputId: inputId(execution),
          input: { role: "user", content: [{ type: "text", text: execution.task.input }] },
          signal: context.signal, tools: [], shouldYield: () => false, report: context.report });
      } finally { context.signal.removeEventListener("abort", disconnect); }
    },
    async recover(execution) {
      await writeFile(controlPath, JSON.stringify({ method: "recover", cancelRequested: execution.task.cancelRequested === true }) + "\n", { flag: "a" });
      const outcome = await rpc.inspect(execution.task.sessionId, inputId(execution));
      if (outcome.status === "not-started") return outcome;
      if (outcome.status === "completed") return { status: "completed", output: { text: outcome.text ?? "" } };
      if (["failed", "cancelled"].includes(outcome.status)) return { status: outcome.status, detail: outcome.detail ?? outcome.status };
      return { status: "recovery-required", detail: `外部任务状态：${outcome.status}` };
    },
    async cancel(execution) {
      await writeFile(controlPath, JSON.stringify({ method: "cancel", cancelRequested: execution.task.cancelRequested === true }) + "\n", { flag: "a" });
      await rpc.inspect(execution.task.sessionId, inputId(execution));
      await rpc.cancel(execution.task.sessionId);
    },
  };
  async function openWorker() {
    worker = await CoordinationWorker.open({ directory: join(directory, "worker"), token, agents: { files: bridge }, authorize: () => true });
    server = createHttpServer(worker.handle); server.listen(0, "127.0.0.1"); await once(server, "listening");
    return createRemoteAgent({ url: `http://127.0.0.1:${server.address().port}`, token, agent: "files", version: "1", pollIntervalMs: 10 });
  }
  async function closeWorker() {
    await worker.close(); server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  const remote = await openWorker();
  async function task() {
    const sessionId = await rpc.createConversation(randomUUID());
    return { coordinationId: "worker-test", dependencies: [], messages: [], task: {
      id: randomUUID(), agent: "remote", agentVersion: "1", dispatchId: randomUUID(), sessionId,
      input: JSON.stringify({ operation: "waitForFile", path: `${sessionId}.txt` }), dependsOn: [], turn: 0, status: "running",
    } };
  }
  function taskFile(execution) {
    return join(stateDirectory, `${execution.task.sessionId}-${createHash("sha256").update(inputId(execution)).digest("hex")}.json`);
  }
  async function taskRecord(execution) {
    return readFile(taskFile(execution), "utf8").then(JSON.parse, error => { if (error.code === "ENOENT") return undefined; throw error; });
  }
  async function journal() {
    const records = (await readFile(join(directory, "worker", "worker.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    return records.at(-1).job;
  }
  async function controls() { return (await readFile(controlPath, "utf8")).trim().split("\n").map(JSON.parse); }
  return { directory, rpc, bridge, remote, task, taskRecord, journal, controls, disconnect,
    stopProxy, startProxy, openWorker, closeWorker,
    async finish(execution) { await writeFile(join(directory, `${execution.task.sessionId}.txt`), "任务完成"); } };
}

function inputId(execution) { return `${execution.task.dispatchId}:${execution.task.turn ?? 0}`; }
