import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { FileSessionStore } from "@may/session/file-store";
import { FileSessionCatalog } from "@may/session/catalog";
import { GitWorkspaceConflictError } from "@may/application/git-workspace";
import { chromium } from "playwright";
import { keyStroke } from "../../../keybindings/dist/index.js";
import { WorkspaceDiffViewer } from "../../../tui/dist/index.js";
import { loadMayConfig } from "../../../../config/dist/index.js";
import { createBuiltinProviderModel, selectProviderModel } from "../../../../providers/dist/index.js";
import { MaybeCodeWorkspace, createMaybeCodeWebHost, startMaybeCodeWebServer } from "../../../../../apps/maybecode/dist/index.js";

const execute = promisify(execFile);

test("真实 Provider 与 MaybeCode WebUI 完成回复分支、worktree 和文件恢复", {
  timeout: 240_000, skip: process.env.MAY_LIVE_PROVIDER_UI_TESTS !== "1" || process.env.MAY_GIT_CHECKPOINT_TEST_COMMITS !== "1",
}, async t => {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
  const base = join(repositoryRoot, "review", "web-ui-browser");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "session-fork-live-"));
  const workspace = join(directory, "project"); await mkdir(workspace);
  const signals = join(directory, "hook-signals"); await mkdir(signals);
  let app, server, browser;
  const temporaryVariables = Object.fromEntries(["TMP", "TEMP", "TMPDIR", "MAY_UI_CHECKPOINT_HOOK", "MAY_UI_CHECKPOINT_SIGNALS"].map(key => [key, process.env[key]]));
  for (const key of ["TMP", "TEMP", "TMPDIR"]) process.env[key] = directory;
  t.after(async () => {
    await writeFile(join(signals, "release"), "release\n");
    await browser?.close(); await server?.close(); await app?.close();
    for (const [key, value] of Object.entries(temporaryVariables)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const child = relative(base, directory); assert.ok(child && !child.startsWith(".."));
    await rm(directory, { recursive: true, force: true });
  });
  const git = async (...args) => (await execute("git", args, { cwd: workspace })).stdout.trim();
  await git("init", "-b", "main");
  assert.equal(resolve(await git("rev-parse", "--show-toplevel")), await realpath(workspace));
  await git("config", "--local", "user.name", "May browser integration test");
  await git("config", "--local", "user.email", "may-test@example.invalid");
  await git("config", "--local", "core.autocrlf", "false");
  await writeFile(join(workspace, "value.txt"), "INITIAL_VALUE\n");
  const config = await loadMayConfig();
  app = await MaybeCodeWorkspace.open({ workspace,
    model: createBuiltinProviderModel(selectProviderModel(config, { model: "deepseek-v4-flash" })),
    store: new FileSessionStore(join(directory, "sessions")), catalog: new FileSessionCatalog(join(directory, "catalog.json")),
    goals: false, subagents: false, skills: false,
    permissionPolicy: check => ["shell", "bash"].includes(check.tool.name) ? "deny" : "allow",
    instructions: "Follow the requested file edits exactly. Use the provided read, write and edit tools. Do not run shell commands. Keep replies short.",
    git: { dataRoot: join(directory, "records"), worktreesRoot: join(directory, "worktrees"), authorizeCommit(request) {
      assert.ok(resolve(request.workspace) === resolve(workspace) || resolve(request.workspace).startsWith(`${resolve(directory, "worktrees")}${sep}`));
      return true;
    } },
  });
  const token = randomBytes(32).toString("hex");
  const host = createMaybeCodeWebHost(app);
  server = await startMaybeCodeWebServer(host, { token, port: 0, browserLogin: true });
  browser = await chromium.launch({ headless: true, artifactsDir: directory, downloadsPath: directory });
  const page = await browser.newPage(); const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(server.createLoginUrl());
  await page.waitForFunction(() => document.querySelector(".workspace-git-status")?.textContent === "main");
  const originalId = app.sessionId;
  const hook = fileURLToPath(new URL("../fixtures/checkpoint-block-hook", import.meta.url));
  await copyFile(hook, join(workspace, ".git", "hooks", "pre-commit"));
  await chmod(join(workspace, ".git", "hooks", "pre-commit"), 0o755);
  process.env.MAY_UI_CHECKPOINT_HOOK = fileURLToPath(new URL("../fixtures/checkpoint-block-hook.mjs", import.meta.url));
  process.env.MAY_UI_CHECKPOINT_SIGNALS = signals;
  await submit(page, "Change value.txt to exactly FIRST_VERSION followed by a newline. Create extra.txt containing exactly FIRST_EXTRA followed by a newline.");
  await until(() => existsSync(join(signals, "started")));
  assert.equal(app.isRunning, true);
  const finalizing = await host.snapshot();
  assert.equal(finalizing.commands.includes("session.fork"), false);
  const finalizingPoint = (await app.getForkPoints(originalId)).at(-1);
  assert.ok(finalizingPoint);
  const blocked = await fetch(`${server.url}/api/ui/commands`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ version: 1, hostId: host.hostId, requestId: randomUUID(), name: "session.fork", targetId: originalId, expectedActiveId: originalId, args: { pointId: finalizingPoint.id, mode: "current" } }),
  });
  assert.equal(blocked.status, 409); assert.equal(app.sessionId, originalId);
  await writeFile(join(signals, "release"), "release\n");
  await page.waitForFunction(() => [...document.querySelectorAll(".reply-version-actions button")].some(button => button.textContent === "创建分支" && !button.disabled), undefined, { timeout: 120_000 });
  await page.waitForFunction(() => document.querySelector(".reply-version-actions .checkpoint-version")?.textContent?.startsWith("main ·"));
  assert.equal(await readFile(join(workspace, "value.txt"), "utf8"), "FIRST_VERSION\n");
  const first = (await app.getForkPoints(originalId)).find(point => point.available && point.worktreeAvailable);
  assert.ok(first, JSON.stringify(await app.getCheckpoints(originalId)));
  await submit(page, "Change value.txt to exactly LATER_VERSION followed by a newline. Keep extra.txt unchanged.");
  await page.waitForFunction(() => document.querySelectorAll(".reply-version-actions").length === 2 && [...document.querySelectorAll(".reply-version-actions button")].filter(button => button.textContent === "创建分支").every(button => !button.disabled), undefined, { timeout: 120_000 });
  await page.waitForFunction(() => [...document.querySelectorAll(".reply-version-actions")].every(row => row.querySelector(".checkpoint-version")?.textContent?.startsWith("main ·")));
  assert.equal(await readFile(join(workspace, "value.txt"), "utf8"), "LATER_VERSION\n");
  await page.locator(".reply-version-actions").first().getByRole("button", { name: "创建分支", exact: true }).click();
  await page.locator(".workspace-dialog").getByRole("button", { name: "当前工作区", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".workspace-dialog")?.hasAttribute("open"));
  const currentId = app.sessionId;
  assert.notEqual(currentId, originalId); assert.equal(app.workspace, workspace);
  assert.equal(await readFile(join(workspace, "value.txt"), "utf8"), "LATER_VERSION\n");
  assert.equal((await app.history()).some(event => event.type === "input.submitted" && event.message.content.some(part => part.text?.includes("LATER_VERSION"))), false);
  await page.waitForFunction(() => document.querySelectorAll(".reply-version-actions").length === 1);
  await page.locator(".reply-version-actions").getByRole("button", { name: "本轮文件变化", exact: true }).click();
  await page.locator(".workspace-dialog").getByRole("button", { name: "预览恢复 value.txt", exact: true }).click();
  await page.locator(".workspace-dialog").getByRole("button", { name: "确认恢复文件", exact: true }).waitFor();
  assert.match(await page.locator(".workspace-patch").textContent(), /FIRST_VERSION/);
  await writeFile(join(workspace, "value.txt"), "EXTERNAL_CHANGE\n");
  const rejectedRestore = page.waitForResponse(response => response.url().endsWith("/api/ui/commands") && response.request().postDataJSON()?.name === "changes.restore.apply");
  await page.locator(".workspace-dialog").getByRole("button", { name: "确认恢复文件", exact: true }).click();
  const rejectedResponse = await rejectedRestore;
  assert.equal(rejectedResponse.status(), 409);
  assert.match((await rejectedResponse.json()).error, /changed/);
  await page.waitForFunction(() => [...document.querySelectorAll(".workspace-dialog .dialog-error")].some(error => error.textContent?.includes("changed")));
  assert.equal(await readFile(join(workspace, "value.txt"), "utf8"), "EXTERNAL_CHANGE\n");
  await page.locator(".workspace-dialog").getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator(".reply-version-actions").getByRole("button", { name: "本轮文件变化", exact: true }).click();
  await page.locator(".workspace-dialog").getByRole("button", { name: "预览恢复 value.txt", exact: true }).click();
  await rm(join(signals, "started")); await rm(join(signals, "release"));
  const restoredResponse = page.waitForResponse(response => response.url().endsWith("/api/ui/commands") && response.request().postDataJSON()?.name === "changes.restore.apply");
  await page.locator(".workspace-dialog").getByRole("button", { name: "确认恢复文件", exact: true }).click();
  await until(() => existsSync(join(signals, "started")));
  assert.equal(app.isRunning, true);
  await assert.rejects(() => app.newSession(), /active workspace operation/);
  await assert.rejects(() => app.resumeSession(originalId), /active workspace operation/);
  await assert.rejects(() => app.submit({ input: "Read value.txt and report its content." }), /active workspace operation/);
  assert.equal(app.sessionId, currentId);
  await writeFile(join(signals, "release"), "release\n");
  assert.equal((await restoredResponse).status(), 200);
  await page.waitForFunction(() => !document.querySelector(".workspace-dialog")?.hasAttribute("open"));
  assert.equal(await readFile(join(workspace, "value.txt"), "utf8"), "FIRST_VERSION\n");
  assert.equal(await git("rev-list", "--count", "HEAD"), "4");
  await page.locator(".reply-version-actions").getByRole("button", { name: "创建分支", exact: true }).click();
  await page.locator(".workspace-dialog").getByRole("button", { name: "新建 worktree", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".workspace-dialog")?.hasAttribute("open"));
  const worktreeId = app.sessionId;
  assert.notEqual(worktreeId, currentId); assert.notEqual(app.workspace, workspace);
  assert.equal(await readFile(join(app.workspace, "value.txt"), "utf8"), "FIRST_VERSION\n");
  assert.equal(await readFile(join(app.workspace, "extra.txt"), "utf8"), "FIRST_EXTRA\n");
  assert.equal((await app.getWorkspaceGit()).commit, first.commit);
  await page.waitForFunction(() => document.querySelector(".workspace-git-status")?.textContent?.startsWith("may/session-"));
  const stale = await fetch(`${server.url}/api/ui/commands`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ version: 1, hostId: host.hostId, requestId: randomUUID(), name: "session.fork", targetId: originalId, expectedActiveId: originalId, args: { pointId: first.id, mode: "current" } }),
  });
  assert.equal(stale.status, 409); assert.equal(app.sessionId, worktreeId);
  await writeFile(join(app.workspace, "value.txt"), "TUI_CHANGED\n");
  const terminalDiff = await app.getChanges({ scope: "run", runId: first.runId });
  let terminalClosed = false;
  const viewer = new WorkspaceDiffViewer(terminalDiff, {
    onClose: () => { terminalClosed = true; },
    onRestore: async path => (await app.previewRestore(first.runId, [path])).diff,
    onApply: previewId => app.restoreFiles(previewId),
  });
  const terminalKey = value => keyStroke(value, value.length === 1 ? { text: value } : {});
  for (let index = 0; viewer.selectedFile?.path !== "value.txt" && index < terminalDiff.files.length; index++) viewer.handleKey(terminalKey("down"));
  assert.equal(viewer.selectedFile?.path, "value.txt");
  viewer.handleKey(terminalKey("enter")); viewer.handleKey(terminalKey("/"));
  for (const value of "first") viewer.handleKey(terminalKey(value));
  await viewer.waitForPending();
  assert.match(viewer.render({ width: 100, height: 24 }).lines.join("\n"), /搜索：first/);
  viewer.handleKey(terminalKey("escape"));
  for (const modifier of ["ctrl", "alt", "meta"]) {
    viewer.handleKey(keyStroke("r", { [modifier]: true }));
    await viewer.waitForPending();
    assert.doesNotMatch(viewer.render({ width: 100, height: 24 }).lines.join("\n"), /Y 确认恢复文件/);
  }
  viewer.handleKey(terminalKey("r"));
  await viewer.waitForPending();
  assert.match(viewer.render({ width: 100, height: 24 }).lines.join("\n"), /Y 确认恢复文件/);
  for (const modifier of ["ctrl", "alt", "meta"]) {
    viewer.handleKey(keyStroke("y", { [modifier]: true }));
    await viewer.waitForPending();
    assert.equal(terminalClosed, false);
    assert.equal(await readFile(join(app.workspace, "value.txt"), "utf8"), "TUI_CHANGED\n");
  }
  viewer.handleKey(terminalKey("y")); await viewer.waitForPending();
  assert.equal(terminalClosed, true);
  assert.equal(await readFile(join(app.workspace, "value.txt"), "utf8"), "FIRST_VERSION\n");
  await writeFile(join(app.workspace, "value.txt"), "BEFORE_FAILED_RESTORE\n");
  await execute("git", ["-C", app.workspace, "add", "--", "value.txt"]);
  await execute("git", ["-C", app.workspace, "commit", "-m", "Prepare file restoration failure check"]);
  const failedPreview = await app.previewRestore(first.runId, ["value.txt"]);
  await copyFile(fileURLToPath(new URL("../fixtures/checkpoint-reject-hook", import.meta.url)), join(workspace, ".git", "hooks", "pre-commit"));
  const failedRestore = await fetch(`${server.url}/api/ui/commands`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ version: 1, hostId: host.hostId, requestId: randomUUID(), name: "changes.restore.apply", targetId: worktreeId, expectedActiveId: worktreeId, args: { previewId: failedPreview.previewId } }),
  });
  assert.equal(failedRestore.status, 409);
  assert.match((await failedRestore.json()).error, /Git checkpoint 保存失败/);
  assert.equal(app.isRunning, false);
  assert.equal(await readFile(join(app.workspace, "value.txt"), "utf8"), "FIRST_VERSION\n");
  await assert.rejects(() => app.restoreFiles(failedPreview.previewId), error => error instanceof GitWorkspaceConflictError && /changed/.test(error.message));
  await copyFile(hook, join(workspace, ".git", "hooks", "pre-commit"));
  await app.resumeSession(originalId);
  await page.waitForFunction(() => document.querySelector(".workspace-git-status")?.textContent === "main");
  await page.waitForFunction(() => document.querySelectorAll(".reply-version-actions").length === 2);
  assert.deepEqual(errors, []);
});

async function submit(page, text) {
  await page.getByRole("textbox", { name: "消息输入", exact: true }).fill(text);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
}

async function until(condition) {
  const deadline = Date.now() + 120_000;
  while (!await condition()) { if (Date.now() >= deadline) assert.fail("真实工作区操作未在期限内完成。"); await delay(25); }
}
