import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, copyFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { openConfiguredMaybeCode } from "../../dist/index.js";
import { executeDelegationCommand, formatDelegationRequests, formatDelegationTree, renderDelegationTask } from "../../dist/delegation-commands.js";
import { TranscriptStore, TranscriptView } from "@sortedyuan/tui";
import { MAYBECODE_DARK_THEME } from "../../dist/ui/theme.js";

test("真实 provider 的两个只读子任务保留输出并支持运行期间切换状态通知", { timeout: 240000 }, async t => {
  const base = fileURLToPath(new URL("../../../../review/delegation-excerpt/", import.meta.url));
  await mkdir(base, { recursive: true });
  const workspace = await mkdtemp(join(base, "live-"));
  await copyFile(new URL("../../../../packages/ui/tui/README.md", import.meta.url), join(workspace, "tui.md"));
  await copyFile(new URL("../../../../docs/en/guides/subagent-delegation.md", import.meta.url), join(workspace, "delegation.md"));
  const app = await openConfiguredMaybeCode({
    workspace, dataDirectory: join(workspace, "data"), git: false, skills: false, mcp: false,
    observability: false, model: process.env.MAY_TEST_MODEL ?? "gemini-3.8-flash-medium",
    instructions: "Follow the requested delegation exactly. All tasks are read-only. Each child must use read on its assigned document and report evidence in Markdown. Do not modify files. Keep each response under 150 words.",
  });
  assert.equal(app.delegationNotifications, false);
  assert.equal(await executeDelegationCommand(["notifications", "status"], app), "Delegation notifications: off");
  await executeDelegationCommand(["notifications", "on"], app);
  await app.newSession();
  assert.equal(app.delegationNotifications, true);
  await executeDelegationCommand(["notifications", "off"], app);
  await assert.rejects(executeDelegationCommand(["notifications", "invalid"], app));
  await assert.rejects(executeDelegationCommand(["notifications", "on", "extra"], app));
  assert.throws(() => app.setDelegationNotifications("on"), TypeError);
  const events = [];
  let changedWhileRunning = false;
  const relay = (async () => {
    for await (const event of app.events) {
      if (event.type.startsWith("delegation.")) events.push(event);
      if (event.type === "delegation.started") {
        assert.equal(app.isRunning, true);
        await executeDelegationCommand(["notifications", "on"], app);
        assert.equal(app.delegationNotifications, true);
        await executeDelegationCommand(["notifications", "off"], app);
        changedWhileRunning = true;
      }
    }
  })();
  t.after(async () => { await app.close(); await relay; });
  const result = await (await app.submit({ input: "Use delegate_tasks to create exactly two worker children in one call: read-tui (files ['tui.md']) reads tui.md and reports continuationIndent behavior; read-delegation (files ['delegation.md']) reads delegation.md and reports notification settings. Give each a standalone read-only brief asking for a Markdown heading and a two-column Markdown table based on actual file evidence. Wait for both children, then give a short answer citing both reports. Do not read the documents yourself or modify any files." })).result;
  assert.ok(result.message);
  assert.equal(changedWhileRunning, true);
  assert.equal(app.delegationNotifications, false);
  const state = app.getDelegationState();
  assert.equal(state.status, "completed");
  const children = state.tasks.filter(task => task.parentTaskId !== undefined);
  assert.equal(children.length, 2);
  for (const child of children) {
    assert.equal(child.status, "completed");
    const records = await app.delegationToolRecords(child.id);
    assert.ok(records.records.some(record => record.name === "read" && record.status === "completed"));
    assert.ok(records.records.every(record => record.name === "read"));
  }
  const finished = events.find(event => event.type === "delegation.finished");
  assert.ok(finished);
  assert.ok(events.some(event => event.type === "delegation.updated"));
  const notices = [...state.tasks.map(renderDelegationTask), formatDelegationTree(finished.state), formatDelegationRequests(app.listDelegationRequests())];
  for (const task of state.tasks) {
    assert.ok(task.output.length > 0);
    assert.ok(!renderDelegationTask(task).includes(task.output));
  }
  for (const notice of notices) {
    assert.doesNotMatch(notice, /result:/u);
    const store = new TranscriptStore();
    store.appendNotice("info", notice);
    const view = new TranscriptView(store, { theme: MAYBECODE_DARK_THEME });
    for (const width of [24, 80]) {
      const rendered = view.render({ width, height: 2000 });
      const lines = rendered.lines.map(stripVTControlCharacters);
      const pointer = (type, x, y) => ({ type, x, y, button: 0, ctrl: false, alt: false, shift: false });
      view.handlePointer(pointer("down", 2, 0));
      view.handlePointer(pointer("up", width, lines.length - 1));
      assert.equal(view.selectedText, notice);
      view.clearSelection();
    }
  }
  await writeFile(join(workspace, "notices.txt"), notices.join("\n\n"));
  t.diagnostic(JSON.stringify({ requestId: state.requestId, budget: state.budget, tasks: state.tasks.map(task => ({ id: task.id, status: task.status })), evidence: workspace }));
});
