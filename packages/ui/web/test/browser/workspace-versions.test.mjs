import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { AgentWorkspace, defineAgent } from "@may/application";
import { ProjectGitWorkspace } from "@may/application/git-workspace";
import { loadMayConfig } from "../../../../config/dist/index.js";
import { createBuiltinProviderModel, selectProviderModel } from "../../../../providers/dist/index.js";
import { InMemorySessionStore } from "@may/session";
import { InMemorySessionCatalog } from "@may/session/catalog";
import { ApplicationUiHost } from "@may/ui-client/application";
import { startUiServer } from "@may/ui-client/server";
import { chromium } from "playwright";
import { webUiAssets } from "../../dist/assets.js";

const execute = promisify(execFile);

test("真实 Git 版本状态与未提交 diff 在 WebUI 中更新并支持键盘阅读", { timeout: 120_000, skip: process.env.MAY_LIVE_PROVIDER_UI_TESTS !== "1" }, async t => {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
  const base = join(repositoryRoot, "review", "web-ui-browser");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "workspace-versions-"));
  const repository = join(directory, "project");
  let app, server, browser;
  const temporaryVariables = Object.fromEntries(["TMP", "TEMP", "TMPDIR"].map(key => [key, process.env[key]]));
  for (const key of Object.keys(temporaryVariables)) process.env[key] = directory;
  t.after(async () => {
    await browser?.close(); await server?.close(); await app?.close();
    for (const [key, value] of Object.entries(temporaryVariables)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const child = relative(base, directory); assert.ok(child && !child.startsWith(".."));
    await rm(directory, { recursive: true, force: true });
  });
  await execute("git", ["clone", "--quiet", "--no-local", repositoryRoot, repository]);
  const git = await ProjectGitWorkspace.open({ workspace: repository, autoCommit: false, dataRoot: join(directory, "git-data") });
  const store = new InMemorySessionStore();
  const config = await loadMayConfig();
  const definition = defineAgent({
    model: createBuiltinProviderModel(selectProviderModel(config, { model: "deepseek-v4-flash" })),
    permissionPolicy: () => "deny", sessionHistory: false, providerNativeAutoCompaction: false, autoCompactionStrategies: [],
  });
  app = await AgentWorkspace.open({ workspace: repository, store, catalog: new InMemorySessionCatalog(), openApplication: selection => definition.open({ ...selection, store }) });
  const host = new ApplicationUiHost(app, {
    product: { id: "workspace-versions", title: "Workspace versions", subtitle: "", resourceKind: "session", suggestions: [] },
    workspace: async () => {
      try { const value = await git.status(); return { path: repository, status: value.state === "unborn" ? "initializing" : "ready", autoCommit: false, branch: value.branch, commit: value.commit, detached: value.detached }; }
      catch (error) { return { path: repository, status: "error", autoCommit: false, error: error.message }; }
    },
    commands: ["changes.view"],
    execute: async command => {
      assert.equal(command.name, "changes.view");
      const status = await git.status();
      const result = await git.diff({ from: status.commit });
      return { diff: { scope: command.args.scope, title: "当前工作区文件变化", from: result.from, uncommitted: true,
        files: result.files.map(file => ({ path: file.path, status: file.status, binary: file.binary, additions: file.insertions, deletions: file.deletions, patch: file.patch })) } };
    },
  });
  server = await startUiServer({ host, assets: await webUiAssets("Workspace versions", "session", { browserLogin: true }), token: randomBytes(32).toString("hex"), browserLogin: true, port: 0, close: () => host.close() });
  browser = await chromium.launch({ headless: true, artifactsDir: directory, downloadsPath: directory });
  const page = await browser.newPage();
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(server.createLoginUrl());
  await page.waitForFunction(() => document.querySelector(".workspace-git-status")?.textContent === "main");
  await writeFile(join(repository, "checkpoint-example.txt"), "first line\nsecond line\n", "utf8");
  await writeFile(join(repository, "checkpoint-example.bin"), Buffer.from([0, 1, 2, 3]));
  await page.getByRole("button", { name: "查看文件变化", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".diff-summary")?.textContent?.startsWith("2 个文件"));
  await page.getByRole("button", { name: /checkpoint-example.txt ·/ }).click();
  await page.getByRole("searchbox", { name: "搜索 diff 内容" }).fill("second line");
  assert.match(await page.locator(".diff-match").textContent(), /second line/);
  await page.getByRole("button", { name: "下一处修改", exact: true }).click();
  assert.equal(await page.locator(".diff-current-hunk").count(), 1);
  await page.getByRole("button", { name: /checkpoint-example.bin ·/ }).click();
  assert.equal(await page.getByText("二进制文件无法显示文本 diff。", { exact: true }).count(), 1);
  await page.locator(".workspace-dialog").getByRole("button", { name: "关闭", exact: true }).click();
  await execute("git", ["-C", repository, "switch", "-c", "codex/ui-version-test"]);
  await page.waitForFunction(() => document.querySelector(".workspace-git-status")?.textContent === "codex/ui-version-test");
  await execute("git", ["-C", repository, "switch", "--detach", "HEAD"]);
  await page.waitForFunction(() => document.querySelector(".workspace-git-status")?.textContent?.startsWith("detached HEAD · "));
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await rename(join(repository, ".git"), join(repository, ".git-hidden"));
  await page.waitForFunction(() => document.querySelector(".workspace-git-status")?.textContent === "Git 状态读取失败");
  assert.deepEqual(errors, []);
});
