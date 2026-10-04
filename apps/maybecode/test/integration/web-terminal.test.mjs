import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { openConfiguredMaybeCode, executeMaybeCodeSlashCommand } from "../../dist/index.js";
import { MaybeCodeTerminalWeb } from "../../dist/terminal-web.js";

test("真实 Provider：终端和 Web 共享会话、审批、事件与关闭行为", { skip: process.env.MAYBECODE_WEB_LIVE !== "1", timeout: 120_000 }, async t => {
  const parent = fileURLToPath(new URL("../../../../review/web-terminal", import.meta.url));
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "live-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const app = await openConfiguredMaybeCode({ git: false, workspace, dataDirectory: join(directory, "data"), autoResume: false, mcp: false, skills: false, observability: false, retry: false, maxSteps: 4,
    runBudget: { maxModelCalls: 4, maxDurationMs: 60_000 } });
  const terminal = new MaybeCodeTerminalWeb(app);
  t.after(() => terminal.close());
  const observed = [];
  const events = (async () => { for await (const event of terminal.events) observed.push(event); })();
  assert.deepEqual(await executeMaybeCodeSlashCommand("/web", app), { type: "web.requested" });
  assert.equal((await executeMaybeCodeSlashCommand("/web extra", app)).type, "usage");
  const server = await terminal.startServer();
  assert.equal(await terminal.startServer(), server);
  const link = new URL(server.createLoginUrl());
  const ticket = new URLSearchParams(link.hash.slice(1)).get("may-connect");
  const exchange = (origin = server.url) => fetch(server.url + "/api/ui/connect", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ ticket }) });
  assert.equal((await exchange("https://untrusted.invalid")).status, 403);
  const response = await exchange();
  assert.equal(response.status, 200);
  const { token } = await response.json();
  assert.equal((await exchange()).status, 401);
  assert.equal((await fetch(server.url + "/api/ui/snapshot")).status, 401);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const snapshot = async () => {
    const response = await fetch(server.url + "/api/ui/snapshot", { headers });
    assert.equal(response.status, 200);
    return response.json();
  };
  const initial = await snapshot();
  assert.equal(initial.activeId, app.sessionId);
  assert.equal(initial.panels.find(p => p.id === "workspace").fields[0].value, await realpath(workspace));
  const command = async (state, name, args, requestId) => {
    const response = await fetch(server.url + "/api/ui/commands", { method: "POST", headers, body: JSON.stringify({ version: 1, hostId: state.hostId, requestId, name, targetId: state.activeId, expectedActiveId: state.activeId, args }) });
    assert.equal(response.status, 200, await response.text());
  };
  await command(initial, "message.submit", { text: "请只使用 write 工具创建 acceptance.txt，内容为 WEB_TERMINAL_OK，随后简短确认。不要执行 shell。" }, "submit");
  let approval;
  for (let i = 0; i < 400; i++) {
    const state = await snapshot();
    approval = state.interactions.find(item => item.kind === "approval");
    if (approval) {
      for (const name of ["session.activate", "session.delete", "session.new"]) {
        assert.ok(!state.commands.includes(name));
        const blocked = await fetch(server.url + "/api/ui/commands", { method: "POST", headers, body: JSON.stringify({ version: 1, hostId: state.hostId, requestId: name, name, targetId: state.activeId, expectedActiveId: state.activeId, args: {} }) });
        assert.equal(blocked.status, 409);
      }
      await command(state, "approval.resolve", { id: approval.id, decision: "allow" }, "approve"); break;
    }
    if (!app.isRunning) break;
    await delay(100);
  }
  assert.ok(approval, "真实工具审批应出现在 Web UI");
  for (let i = 0; app.isRunning && i < 400; i++) await delay(100);
  assert.equal(app.isRunning, false);
  assert.match(await readFile(join(workspace, "acceptance.txt"), "utf8"), /WEB_TERMINAL_OK/);
  const completed = await snapshot();
  assert.equal(completed.interactions.length, 0);
  assert.ok(completed.blocks.some(block => block.kind === "tool"));
  assert.ok(observed.some(event => event.type === "permission.event" && event.event.type === "approval.requested" && event.event.request.id === approval.id));
  assert.ok(observed.some(event => event.type === "permission.event" && event.event.type === "approval.resolved" && event.event.requestId === approval.id));
  assert.ok(observed.some(event => event.type === "run.event" && event.event.type === "model.text.delta"));
  await command(completed, "session.new", {}, "new-session");
  assert.notEqual(app.sessionId, initial.activeId);
  await server.close();
  await app.newSession();
  await terminal.close();
  await events;
  assert.ok(observed.some(event => event.type === "session.changed"));
  await assert.rejects(fetch(server.url + "/api/ui/snapshot", { headers }));
});
