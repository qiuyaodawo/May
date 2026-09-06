import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMcpClientPool } from "@may/mcp";
import { FileSessionStore } from "@may/session/file-store";
import { MaybeCodeWorkspace, InMemorySessionCatalog, executeMaybeCodeSlashCommand } from "../dist/index.js";
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
