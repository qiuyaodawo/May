import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySessionStore } from "@may/session";
import { InMemorySessionCatalog, MaybeCodeWorkspace, parseMaybeCodeArgs, startMaybeCodeWebUI } from "../dist/index.js";

test("MaybeCode web entry serves browser-only modules and preserves session guards", async t => {
  assert.equal(parseMaybeCodeArgs(["--ui", "web", "--port", "0"]).port, 0);
  assert.throws(() => parseMaybeCodeArgs(["--port", "3940"]), /requires --ui web/);
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "may-web-ui-")));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const app = await MaybeCodeWorkspace.open({ git: false, workspace, model: { async *stream() { yield { type: "response.completed", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }; } }, store: new InMemorySessionStore(), catalog: new InMemorySessionCatalog(), autoResume: false });
  const token = "fixture-token-0123456789abcdef012345";
  const server = await startMaybeCodeWebUI(app, { token, port: 0 }); t.after(() => server.close());
  const page = await fetch(server.url); assert.equal(page.status, 200); assert.match(await page.text(), /data-kind="session"/);
  for (const path of ["/app.css", "/app.js", "/webui/index.js", "/webui/components.js", "/webui/markdown.js", "/ui/client.js", "/ui/protocol.js"]) {
    const response = await fetch(server.url + path); assert.equal(response.status, 200, path);
    assert.ok(!(await response.text()).includes('from "node:'), path);
  }
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const state = await (await fetch(server.url + "/api/ui/snapshot", { headers })).json();
  assert.equal(state.product.id, "maybecode"); assert.ok(state.commands.includes("message.submit"));
  assert.ok(!state.commands.includes("team.apply"));
  const response = await fetch(server.url + "/api/ui/commands", { method: "POST", headers, body: JSON.stringify({ version: 1, hostId: state.hostId, requestId: "new", name: "session.new", targetId: state.selectedId, expectedActiveId: state.activeId, args: {} }) });
  assert.equal(response.status, 200); assert.notEqual((await response.json()).selectedId, state.selectedId);
});
