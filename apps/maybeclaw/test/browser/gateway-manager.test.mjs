import assert from "node:assert/strict";
import { testOutputRoot } from "@sortedyuan/test-support";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { chromium } from "playwright";
import { AgentGateway } from "../../dist/gateway.js";
import { gatewaySettings } from "../../dist/gateway-settings.js";
import { startGatewayServer } from "../../dist/plugins/web-api.js";

const operator = { kind: "operator", id: "tester" };
const testFileName = "compute-target.txt";
const testFileContent = "真实文件内容，供 RPC 文件 Agent 子进程执行 sha256 运算验证。\n";
const inputMessage = JSON.stringify({ operation: "sha256", path: testFileName });

describe("MaybeClaw 管理界面", { timeout: 90_000 }, () => {
  const base = join(testOutputRoot, "maybeclaw", "browser");
  const password = `admin-${randomBytes(16).toString("hex")}`;
  const errors = [];
  let directory, gateway, server, browser, page, session, completedTask;

  const composer = () => page.getByLabel("消息输入", { exact: true });
  const sendButton = () => page.getByRole("button", { name: "发送消息", exact: true });
  const cancelButton = () => page.locator(".stop-button");
  const openDialog = async (button, heading = button) => {
    await page.getByRole("button", { name: button, exact: true }).click();
    const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: heading, exact: true }) });
    await dialog.waitFor({ state: "visible" });
    return dialog;
  };

  before(async () => {
    await mkdir(base, { recursive: true });
    directory = await mkdtemp(join(base, "manager-"));
    const path = join(directory, "config.json");
    // 真实 stdio 外部 Agent 模块，计算实际文件 sha256 摘要
    const config = {
      apps: {
        maybeclaw: {
          version: 2,
          agents: [
            {
              id: "file-agent",
              name: "文件计算助手",
              adapter: "module",
              enabled: true,
              module: fileURLToPath(new URL("../../dist/gateway-rpc-adapter.js", import.meta.url)),
              options: {
                transport: "stdio",
                command: process.execPath,
                args: [
                  fileURLToPath(new URL("../../examples/rpc-file-agent.mjs", import.meta.url)),
                  "--directory",
                  join(directory, "rpc-state"),
                  "--workspace",
                  directory,
                ],
              },
            },
          ],
          access: { creators: [], deniedUsers: [], sessionAdmins: {}, allowedAgents: {} },
          server: {
            maxConcurrent: 4,
            approvalMs: 60000,
            idleMs: 120000,
            shutdownMs: 15000,
            auth: { password },
            publicOrigin: "https://gateway.example.com",
          },
        },
      },
    };
    await writeFile(path, JSON.stringify(config, null, 2));
    await writeFile(join(directory, testFileName), testFileContent, "utf8");
    gateway = new AgentGateway({ directory, configPath: path, settings: gatewaySettings(config) });
    session = gateway.createSession(operator, "真实文件计算会话", ["file-agent"]);
    await gateway.handle(inputMessage, operator, { requestId: "req-compute-1", sessionId: session.id });
    for (let attempt = 0; attempt < 100 && completedTask === undefined; attempt++) {
      completedTask = gateway.store
        .list("tasks")
        .find((task) => task.sessionId === session.id && task.status === "completed");
      if (completedTask === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    server = await startGatewayServer({ gateway, port: 0 });
    browser = await chromium.launch({
      headless: true,
      env: { ...process.env, TEMP: directory, TMP: directory, TMPDIR: directory },
    });
    page = await browser.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url);
  });

  after(async () => {
    await browser?.close();
    if (server) await server.close();
    else await gateway?.close();
    if (directory !== undefined) {
      const child = relative(base, directory);
      assert.ok(child && !child.startsWith(".."));
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("RPC 子进程 Agent 完成任务并保存文件摘要", () => {
    assert.ok(completedTask, "真实子进程 Agent 任务应当在超时前执行完成");
    assert.equal(completedTask.agentId, "file-agent");
    const expectedHash = createHash("sha256").update(testFileContent).digest("hex");
    assert.ok(
      gateway.messages(session.id, operator).some((message) => message.text.includes(expectedHash)),
      "真实子进程应当计算并返回正确的 sha256 摘要结果",
    );
  });

  test("管理员登录后不预选会话", async () => {
    await page.locator(".connection-button").click();
    await page.getByLabel("管理员密码", { exact: true }).fill(password);
    const snapshot = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/ui/snapshot" && response.status() === 200,
    );
    await page.getByRole("button", { name: "连接", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".new-button")?.disabled);
    assert.equal((await (await snapshot).json()).selectedId, null);
    assert.equal(await page.locator(".resource-item.selected").count(), 0);
  });

  test("未选择会话时只能发送管理命令", async () => {
    await composer().fill(inputMessage);
    assert.equal(await sendButton().isVisible(), true);
    assert.equal(await sendButton().isDisabled(), true);
    assert.equal(await cancelButton().isVisible(), false);
    await composer().fill("/status");
    await page.waitForFunction(() => document.querySelector("button[aria-label='发送消息']")?.disabled === false);
    assert.equal(await sendButton().isEnabled(), true);
  });

  test("/status 命令返回任务状态且不创建任务", async () => {
    const initialTaskIds = gateway.store
      .list("tasks")
      .map((task) => task.id)
      .sort();
    const statusText = `/status ${completedTask.id}`;
    await composer().fill(statusText);
    const pending = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/ui/commands" && response.request().method() === "POST",
    );
    await sendButton().click();
    const response = await pending;
    assert.equal(response.status(), 200);
    const command = response.request().postDataJSON();
    assert.equal(command.name, "gateway.command");
    assert.equal(command.args.text, statusText);
    assert.equal(command.targetId, null);
    const receipt = await response.json();
    assert.ok(receipt.output.text.includes(completedTask.id));
    assert.ok(receipt.output.text.includes("completed"));
    assert.equal(receipt.selectedId, session.id);
    assert.deepEqual(
      gateway.store
        .list("tasks")
        .map((task) => task.id)
        .sort(),
      initialTaskIds,
    );
    await page.waitForFunction(() => document.querySelector("textarea[aria-label='消息输入']")?.value === "");
  });

  test("侧栏按管理类别分组", async () => {
    const nav = page.locator(".sidebar-navigation");
    await nav.waitFor({ state: "visible" });
    const groupTitles = await nav.locator(".nav-group-title").allTextContents();
    for (const title of ["会话管理", "Agent 与任务", "渠道与系统"]) assert.ok(groupTitles.includes(title));
  });

  test("执行任务窗口显示已完成任务，并可切换到它的会话", async () => {
    const tasksDialog = await openDialog("执行任务", "执行任务与协同");
    await tasksDialog.locator(".gateway-summary-bar").waitFor({ state: "visible" });
    const summary = await tasksDialog.locator(".gateway-summary-bar").textContent();
    assert.ok(summary.includes("总任务数：1"));
    assert.ok(summary.includes("运行中：0"));
    const title = await tasksDialog.locator(".gateway-card-title").first().textContent();
    assert.ok(title.includes(completedTask.id.slice(0, 16)));
    assert.ok(title.includes("file-agent"));
    assert.equal(await tasksDialog.locator(".gateway-status-pill").first().textContent(), "[已完成]");
    await tasksDialog.getByRole("button", { name: "切换到该会话", exact: true }).first().click();
    await tasksDialog.waitFor({ state: "detached" });
    await page.waitForFunction((sessionName) => {
      const active = document.querySelector(
        ".sidebar-item.selected, .sidebar-item.active, .resource-item.selected, .resource-item.active",
      );
      return active?.textContent?.includes(sessionName);
    }, session.name);
  });

  test("选择会话后可以发送普通消息", async () => {
    await sendButton().waitFor({ state: "visible" });
    assert.equal(await sendButton().isDisabled(), true);
    assert.equal(await cancelButton().isVisible(), false);
    await composer().fill(inputMessage);
    await page.waitForFunction(() => document.querySelector("button[aria-label='发送消息']")?.disabled === false);
    assert.equal(await sendButton().isEnabled(), true);
    assert.equal(await cancelButton().isVisible(), false);
    await composer().fill("");
  });

  test("服务设置窗口显示实际配置", async () => {
    const dialog = await openDialog("服务设置");
    const settings = gateway.options.settings;
    const summary = await dialog.locator(".gateway-summary-bar").textContent();
    assert.ok(summary.includes(`最大并发：${settings.maxConcurrent}`));
    assert.ok(summary.includes(`配置 Agent：${settings.agents.length}`));
    const meta = await dialog.locator(".gateway-card-meta").textContent();
    assert.ok(meta.includes(`反向代理公网来源：${settings.publicOrigin ?? "未配置反向代理公网来源"}`));
    assert.ok(meta.includes(`最大并发任务数：${settings.maxConcurrent} 项`));
    assert.ok(meta.includes(`空闲释放超时：${settings.idleMs} ms`));
    assert.ok(meta.includes(`审批等待超时：${settings.approvalMs} ms`));
    assert.ok(meta.includes(`创建权限限制人数：${settings.access.creators.length} 人`));
    assert.ok(meta.includes(`禁止访问名单人数：${settings.access.deniedUsers.length} 人`));
    assert.equal(await dialog.locator(".gateway-diag summary").textContent(), "原始服务设置数据（JSON）");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
  });

  test("聊天渠道窗口显示没有投递和绑定入口", async () => {
    const dialog = await openDialog("聊天渠道");
    const summary = await dialog.locator(".gateway-summary-bar").textContent();
    assert.ok(summary.includes("消息投递：0"));
    assert.ok(summary.includes("绑定入口：0"));
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
  });

  test("会话筛选窗口提供名称搜索和状态筛选", async () => {
    const dialog = await openDialog("会话筛选");
    await dialog.getByLabel("搜索会话名称", { exact: true }).waitFor({ state: "visible" });
    await dialog.getByLabel("筛选会话状态", { exact: true }).waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
  });

  for (const size of [
    { width: 320, height: 568, name: "320x568 矮窄屏" },
    { width: 390, height: 844, name: "390x844 标准移动屏幕" },
    { width: 768, height: 500, name: "768x500 矮平板" },
  ]) {
    test(`${size.name}的服务设置表单可以滚动到关闭按钮`, async () => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.waitForTimeout(100);
      const sidebarVisible = await page
        .locator(".sidebar")
        .evaluate((element) => !element.inert && !element.hasAttribute("aria-hidden"));
      if (!sidebarVisible) {
        await page.getByRole("button", { name: "切换侧边栏" }).click();
        await page.waitForFunction(() => document.querySelector(".workbench")?.classList.contains("sidebar-open"));
      }
      const navigationButton = page.getByRole("button", { name: "服务设置", exact: true });
      await navigationButton.waitFor({ state: "visible" });
      await navigationButton.scrollIntoViewIfNeeded();
      await navigationButton.click();
      const dialog = page
        .getByRole("dialog")
        .filter({ has: page.getByRole("heading", { name: "服务设置", exact: true }) });
      await dialog.waitFor({ state: "visible" });
      const overflowY = await dialog
        .locator(".gateway-dialog-form")
        .evaluate((element) => window.getComputedStyle(element).overflowY);
      assert.equal(overflowY, "auto", "表单未配置竖向自动滚动");
      const close = dialog.getByRole("button", { name: "关闭", exact: true });
      await close.scrollIntoViewIfNeeded();
      await close.click();
      await dialog.waitFor({ state: "detached" });
    });
  }

  for (const viewport of [
    { width: 320, height: 600, name: "320px 窄屏" },
    { width: 390, height: 844, name: "390px 标准移动屏幕" },
    { width: 768, height: 1024, name: "768px 平板" },
    { width: 1440, height: 900, name: "1440px 宽屏桌面" },
  ]) {
    test(`${viewport.name}没有页面横向滚动`, async () => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.waitForTimeout(50);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    });
  }

  test("页面没有未捕获的异常", () => {
    assert.equal(errors.length, 0, `浏览器控制台存在未捕获错误: ${errors.join("; ")}`);
  });
});
