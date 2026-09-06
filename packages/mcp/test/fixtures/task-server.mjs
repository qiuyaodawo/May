import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

export function createTaskPeer(file) {
  const saved = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { calls: 0, tasks: {} };
  const state = { ...saved, input: false, before: false, immediate: false, badOutput: false, outputSchema: undefined, version: 1, updates: [], cancels: [], hold: false };
  const persist = () => { if (file) writeFileSync(file, JSON.stringify({ calls: state.calls, tasks: state.tasks })); };
  const form = { method: "elicitation/create", params: { mode: "form", message: "Review task input", requestedSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } } };
  function dispatch(m) {
    if (m.method === "server/discover") return { supportedVersions: ["2026-07-28"], capabilities: { tools: {}, extensions: { "io.modelcontextprotocol/tasks": {} } }, _meta: { "io.modelcontextprotocol/serverInfo": { name: "task-peer", version: "1" } } };
    if (m.method === "tools/list") return { ttlMs: 0, cacheScope: "private", tools: [{ name: "slow", description: `Task version ${state.version}`, inputSchema: { type: "object", properties: { route: { type: "string", "x-mcp-header": "Route" } } }, ...(state.outputSchema ? { outputSchema: state.outputSchema } : {}) }] };
    if (["tools/call", "tasks/get", "tasks/update", "tasks/cancel"].includes(m.method) && !m.params?._meta?.["io.modelcontextprotocol/clientCapabilities"]?.extensions?.["io.modelcontextprotocol/tasks"]) throw new Error("missing task capability");
    if (m.method === "tools/call") {
      if (state.hold) return undefined;
      if (state.before && !m.params.inputResponses) return { resultType: "input_required", inputRequests: { before: form }, requestState: "opaque-creation-state" };
      state.calls++; persist();
      if (state.immediate) return { content: [{ type: "text", text: "immediate" }] };
      const taskId = randomUUID(); const now = new Date().toISOString();
      const task = { taskId, status: state.input ? "input_required" : "working", createdAt: now, lastUpdatedAt: now, ttlMs: 600_000, pollIntervalMs: 250 };
      if (state.input) task.inputRequests = { form, sampling: { method: "sampling/createMessage", params: { messages: [{ role: "user", content: { type: "text", text: "Task-only input" } }], maxTokens: 32 } } };
      state.tasks[taskId] = task; persist(); return { ...task, resultType: "task" };
    }
    const task = state.tasks[m.params?.taskId];
    if (!task) throw new Error("unknown task");
    if (m.method === "tasks/get") return task;
    if (m.method === "tasks/update") {
      state.updates.push(m.params.inputResponses);
      for (const key of Object.keys(m.params.inputResponses)) delete task.inputRequests?.[key];
      if (Object.keys(task.inputRequests ?? {}).length === 0) {
        delete task.inputRequests; task.status = "completed";
        task.result = { content: [{ type: "text", text: "completed task" }], ...(state.badOutput ? { structuredContent: { wrong: true } } : {}) };
      }
      persist(); return {};
    }
    if (m.method === "tasks/cancel") { state.cancels.push(task.taskId); persist(); return {}; }
    throw new Error("unsupported task method");
  }
  return { state, dispatch };
}

export async function startTaskServer(t) {
  const { state, dispatch } = createTaskPeer(); const requests = [];
  const server = createServer(async (request, response) => {
    const parts = []; for await (const part of request) parts.push(part);
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    const message = JSON.parse(Buffer.concat(parts)); requests.push({ message, headers: request.headers });
    try {
      const result = dispatch(message);
      if (result !== undefined) response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { resultType: "complete", ...result } }));
    } catch { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "fixture request rejected" } })); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { state, requests, url: `http://127.0.0.1:${server.address().port}` };
}

if (process.argv.includes("--stdio")) {
  const { dispatch } = createTaskPeer(process.argv[process.argv.indexOf("--stdio") + 1]);
  createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    try {
      const result = dispatch(message);
      if (result !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { resultType: "complete", ...result } }) + "\n");
    } catch { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "fixture rejected" } }) + "\n"); }
  });
}
