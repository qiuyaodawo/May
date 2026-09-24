import { createHash, randomUUID } from "node:crypto";
import { createReadStream, watch } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";

const { values } = parseArgs({ options: { directory: { type: "string" }, workspace: { type: "string" }, socket: { type: "string" }, "no-cancel": { type: "boolean" } } });
if (!values.directory || !values.workspace) throw new Error("--directory and --workspace are required");
const directory = resolve(values.directory), workspace = await realpath(values.workspace);
await mkdir(directory, { recursive: true });
const active = new Map();
const changes = new Map();
const hash = value => createHash("sha256").update(value).digest("hex");
const validId = value => { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid conversation ID"); return value; };
const conversationPath = id => join(directory, validId(id) + ".json");
const taskPath = (id, inputId) => join(directory, validId(id) + "-" + hash(inputId) + ".json");
async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
async function saveJson(path, value) { const pending = `${path}.${randomUUID()}.pending`; await writeFile(pending, JSON.stringify(value), { flag: "wx" }); await rename(pending, path); }
async function changeConversation(id, update) {
  const operation = (changes.get(id) ?? Promise.resolve()).then(async () => {
    const path = conversationPath(id), record = await readJson(path);
    const result = update(record); await saveJson(path, record); return result;
  });
  changes.set(id, operation);
  try { return await operation; }
  finally { if (changes.get(id) === operation) changes.delete(id); }
}
async function exists(path) { return stat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }); }
function within(path) { const result = relative(workspace, path); if (result.startsWith("..") || isAbsolute(result)) throw new Error("File is outside the configured workspace"); return path; }

function serve(reader, writer) {
  const connection = createMessageConnection(new StreamMessageReader(reader), new StreamMessageWriter(writer));
  connection.onRequest("gateway/initialize", ({ protocolVersion }) => {
    if (protocolVersion !== 1) throw new Error("Unsupported protocol version");
    return { protocolVersion: 1, capabilities: { cancel: !values["no-cancel"], steer: true, resume: true, delete: true, approvals: false, collaboration: false, media: [] }, commands: ["status", "process"] };
  });
  connection.onRequest("conversation/create", async ({ requestId }) => {
    if (typeof requestId !== "string" || !requestId) throw new Error("requestId is required");
    const id = hash(requestId), path = conversationPath(id);
    if (!await exists(path)) await writeFile(path, JSON.stringify({ id, requestId }), { flag: "wx" });
    const stored = await readJson(path);
    if (stored.requestId !== requestId) throw new Error("Conversation identity conflict");
    return { conversationId: id };
  });
  connection.onRequest("conversation/inspectCreation", async ({ requestId }) => {
    const id = hash(requestId);
    return await exists(conversationPath(id)) ? { status: "ready", conversationId: id } : { status: "not-started" };
  });
  connection.onRequest("conversation/execute", async ({ conversationId, inputId, input }) => {
    await readJson(conversationPath(conversationId));
    if (typeof inputId !== "string" || !inputId) throw new Error("inputId is required");
    const path = taskPath(conversationId, inputId), inputHash = hash(JSON.stringify(input));
    if (await exists(path)) {
      const previous = await readJson(path);
      if (previous.inputHash !== inputHash) throw new Error("Input identity conflict");
      if (previous.status === "completed") return { text: previous.text, runId: inputId };
      throw new Error("Input already exists; inspect its state before continuing");
    }
    if (active.has(conversationId)) throw new Error("Conversation is running");
    const text = input.content.filter(part => part.type === "text").map(part => part.text).join("\n");
    const command = JSON.parse(text);
    if (!command || !["sha256", "waitForFile"].includes(command.operation) || typeof command.path !== "string") throw new Error("Expected a sha256 or waitForFile operation with a path");
    const target = within(resolve(workspace, command.path));
    within(await realpath(dirname(target)));
    const controller = new AbortController();
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    active.set(conversationId, { inputId, controller, done });
    await saveJson(path, { inputId, inputHash, status: "running" });
    await changeConversation(conversationId, record => { const item = record.steering?.find(value => value.inputId === inputId); if (item) item.status = "delivered"; });
    let completed = false;
    try {
      let result;
      if (command.operation === "sha256") {
        within(await realpath(target));
        const digest = createHash("sha256");
        for await (const chunk of createReadStream(target, { signal: controller.signal })) digest.update(chunk);
        result = digest.digest("hex");
      } else {
        await waitForFile(target, controller.signal);
        within(await realpath(target));
        result = `File is available: ${command.path}`;
      }
      await saveJson(path, { inputId, inputHash, status: "completed", text: result });
      completed = true;
      return { text: result, runId: inputId };
    } catch (error) {
      await saveJson(path, { inputId, inputHash, status: controller.signal.aborted ? "cancelled" : "failed", detail: error.message });
      throw error;
    } finally {
      await changeConversation(conversationId, record => { for (const item of record.steering ?? []) if (item.status === "pending") item.status = completed ? "idle" : "cancelled"; });
      active.delete(conversationId); finish();
    }
  });
  connection.onRequest("conversation/inspect", async ({ conversationId, inputId }) => {
    await readJson(conversationPath(conversationId));
    const path = taskPath(conversationId, inputId);
    if (!await exists(path)) return { status: "not-started" };
    const record = await readJson(path);
    return record.status === "running" && active.get(conversationId)?.inputId !== inputId ? { ...record, status: "recovery-required" } : record;
  });
  connection.onRequest("conversation/cancel", async ({ conversationId }) => {
    if (values["no-cancel"]) throw new Error("Cancellation is disabled for this service");
    const execution = active.get(conversationId);
    if (execution) { execution.controller.abort(new Error("Cancelled by Gateway")); await execution.done; }
    return { cancelled: true };
  });
  connection.onRequest("conversation/steer", async ({ conversationId, inputId, text }) => {
    if (typeof inputId !== "string" || !inputId || typeof text !== "string" || !text.trim()) throw new Error("Steering input requires inputId and text");
    return changeConversation(conversationId, record => {
      record.steering ??= [];
      const previous = record.steering.find(value => value.inputId === inputId);
      if (previous) { if (previous.text !== text) throw new Error("Steering input identity conflict"); return { status: previous.status }; }
      const status = active.has(conversationId) ? "pending" : "idle";
      record.steering.push({ inputId, text, status }); return { status };
    });
  });
  connection.onRequest("conversation/steeringInputs", async ({ conversationId }) => (await readJson(conversationPath(conversationId))).steering ?? []);
  connection.onRequest("conversation/release", ({ conversationId }) => {
    if (active.has(conversationId)) throw new Error("Conversation is running");
    return { released: true };
  });
  connection.onRequest("conversation/delete", async ({ conversationId }) => {
    if (active.has(conversationId)) throw new Error("Conversation is running");
    await unlink(conversationPath(conversationId));
    for (const file of await readdir(directory)) if (file.startsWith(conversationId + "-") && file.endsWith(".json")) await unlink(join(directory, file));
    return { deleted: true };
  });
  connection.onRequest("conversation/command", async ({ conversationId, name }) => {
    await readJson(conversationPath(conversationId));
    if (name === "process") return { text: JSON.stringify({ pid: process.pid }) };
    if (name !== "status") throw new Error("Unknown command");
    return { text: active.has(conversationId) ? "running" : "idle" };
  });
  connection.listen();
}

async function waitForFile(path, signal) {
  signal.throwIfAborted();
  await new Promise((resolve, reject) => {
    const watcher = watch(dirname(path), () => { void inspect().catch(finish); });
    let finished = false;
    const finish = error => { if (finished) return; finished = true; watcher.close(); signal.removeEventListener("abort", cancel); error ? reject(error) : resolve(); };
    const cancel = () => finish(signal.reason);
    const inspect = async () => { if (await exists(path)) finish(); };
    watcher.on("error", finish);
    signal.addEventListener("abort", cancel, { once: true });
    void inspect().catch(finish);
  });
}

if (values.socket) {
  const server = createServer(socket => serve(socket, socket));
  server.listen(values.socket);
} else serve(process.stdin, process.stdout);
