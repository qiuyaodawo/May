import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMcpClientPool, McpInteractionBroker } from "@may/mcp";
import { FileSessionStore } from "@may/session/file-store";
import { MaybeCodeWorkspace, InMemorySessionCatalog, executeMaybeCodeSlashCommand, runTerminalUI, MaybeCodePrototypeView, TranscriptStore } from "../dist/index.js";
import { startCatalogFixture } from "../../../packages/mcp/test/fixtures/catalog-server.mjs";

test("MCP user commands preview safely, explicitly attach to one Session, and cancel preparation without context leakage", { timeout: 10_000 }, async (t) => {
  const fixture = await startCatalogFixture(t);
  const directory = await mkdtemp(join(tmpdir(), "may-mcp-content-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pool = await openMcpClientPool({ servers: [{ id: "remote", transport: "streamable-http", url: `${fixture.url}/modern`, requestTimeoutMs: 1000 }] });
  const requests = [];
  const app = await MaybeCodeWorkspace.open({ workspace: directory, store: new FileSessionStore(join(directory, "sessions")),
    catalog: new InMemorySessionCatalog(), mcp: pool, toolSource: () => pool.tools, tools: [], closeOwnedResources: () => pool.close(),
    model: { async *stream(request) {
      requests.push(request);
      yield { type: "response.completed", message: { role: "assistant", content: [] } };
    } },
  });
  t.after(() => app.close());
  const observed = [];
  const relay = (async () => { for await (const event of app.events) observed.push(event); })();
  const command = (input) => executeMaybeCodeSlashCommand(input, app);
  assert.equal((await command("/mcp catalog remote")).type, "mcp.display");
  const preview = await command("/mcp read remote test:///image");
  assert.match(preview.text, /binary attachment/);
  const promptPreview = await command('/mcp prompt remote review {"file":"a  b.txt"}');
  assert.match(promptPreview.text, /a  b.txt/);
  assert.equal(requests.length, 0, "preview never starts a Run");
  const attached = await command("/mcp attach remote test:///image Inspect this image");
  await attached.run.result;
  assert.equal(requests[0].messages.at(-1).role, "user");
  assert.equal(requests[0].messages.at(-1).content.at(-1).type, "image");
  const used = await command('/mcp use-prompt remote review {"file":"a  b.txt"}');
  await used.run.result;
  const last = requests.at(-1).messages.at(-1);
  assert.equal(last.role, "user");
  assert.ok(last.content.some((part) => part.type === "json" && part.value.remoteRole === "assistant"));
  assert.match((await command('/mcp complete remote {"ref":{"type":"ref/prompt","name":"review"},"argument":{"name":"file","value":"ma"}}')).text, /ma-completed/);
  await command("/mcp watch remote test:///first");
  const notice = new Promise((resolve) => {
    const poll = () => observed.some((event) => event.type === "mcp.resource.updated") ? resolve() : setTimeout(poll, 5);
    poll();
  });
  fixture.update("test:///first"); await notice;
  assert.equal(requests.length, 2, "notifications never attach changed resources automatically");
  await command("/mcp unwatch remote test:///first");
  const oldSession = app.sessionId;
  const pending = assert.rejects(command("/mcp attach remote test:///hold"));
  const switched = app.newSession();
  assert.equal(app.isRunning, true);
  app.cancel("cancel attachment preparation");
  await pending; await switched;
  assert.notEqual(app.sessionId, oldSession);
  assert.equal(requests.length, 2);
  await app.close(); await relay;
});

test("MCP terminal forms resolve nested preparation and Run requests outside the Session queue without persisting answers", { timeout: 10_000 }, async (t) => {
  const fixture = await startCatalogFixture(t);
  fixture.state.input = (m) => {
    if (["tools/call", "resources/read"].includes(m.method) && !m.params.inputResponses) return {
      resultType: "input_required", requestState: "next", inputRequests: { form: { method: "elicitation/create", params: {
        mode: "form", message: "Untrusted \u001b[2J request", requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      } } },
    };
  };
  const directory = await mkdtemp(join(tmpdir(), "may-mcp-ui-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pool = await openMcpClientPool({ interactions: new McpInteractionBroker(), servers: [{ id: "remote", transport: "streamable-http", url: `${fixture.url}/modern` }] });
  const modelRequests = [];
  const app = await MaybeCodeWorkspace.open({ workspace: directory, store: new FileSessionStore(join(directory, "sessions")),
    catalog: new InMemorySessionCatalog(), mcp: pool, toolSource: () => pool.tools, tools: [], closeOwnedResources: () => pool.close(),
    model: { async *stream(request, { step }) {
      modelRequests.push(request);
      yield { type: "response.completed", message: { role: "assistant", content: [],
        ...(step === 1 ? { toolCalls: [{ id: "tool-one", name: pool.tools[0].name, input: {} }] } : {}),
      } };
    } },
  });
  t.after(() => app.close());
  const questions = [];
  const owners = [];
  const terminal = { colors: false, write() {}, close() {}, async question(prompt, options = {}) {
    questions.push(prompt);
    if (prompt.includes("Enter a JSON object")) {
      assert.equal(options.history, false);
      owners.push(app.getMcpInteractions()[0].owner);
      return '{"name":"ephemeral-form-answer"}';
    }
    if (prompt.includes("Type send")) return "send";
    if (prompt.includes("[a]")) return "a";
    return questions.length === 1 ? "/mcp attach remote test:///first" : "/exit";
  } };
  await runTerminalUI(app, { terminal });
  assert.equal(owners.length, 2);
  assert.equal(owners[0].workspaceId, directory); assert.equal(owners[0].sessionId, owners[1].sessionId);
  assert.equal(owners[0].runId, undefined); assert.ok(owners[1].runId); assert.equal(owners[1].toolCallId, "tool-one");
  assert.equal(JSON.stringify(modelRequests).includes("ephemeral-form-answer"), false);
  assert.equal(questions.some((q) => q.includes("\u001b[2J")), false);

  // The retained dialog has no command history; queued questions and cancellation
  // are ephemeral and do not route through the normal onSubmit callback.
  const store = new TranscriptStore();
  const view = new MaybeCodePrototypeView({ store, workspace: directory, onSubmit() { assert.fail("form must not submit an agent turn"); } });
  const first = new AbortController(); const second = new AbortController();
  const a = view.requestMcpInput("First MCP form", first.signal);
  const b = view.requestMcpInput("Second MCP form", second.signal);
  first.abort(); assert.equal(await a, undefined);
  assert.match(view.render({ width: 100, height: 28 }).lines.join("\n"), /Second MCP form/);
  const key = (key, text) => ({ key, text, ctrl: false, alt: false, shift: false, meta: false });
  for (const ch of "cancel") view.handleKey(key(ch, ch));
  view.handleKey(key("enter")); assert.equal(await b, "cancel");
  const c = view.requestMcpInput("Closing form", second.signal);
  view.dispose(); assert.equal(await c, undefined);
});
