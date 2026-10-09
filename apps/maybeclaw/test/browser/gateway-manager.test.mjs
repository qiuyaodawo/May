import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright";
import { AgentGateway } from "../../dist/gateway.js";
import { gatewaySettings } from "../../dist/gateway-settings.js";
import { startGatewayServer } from "../../dist/gateway-server.js";

test("MaybeClaw 类型化管理导航、结构化信息面板与可访问性真实浏览器集成测试", { timeout: 90_000 }, async t => {
  const base = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../review/maybeclaw-browser");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "manager-"));
  const path = join(directory, "config.json");
  const password = `admin-${randomBytes(16).toString("hex")}`;

  // 1. 配置真实 stdio 外部 Agent 模块，计算实际文件 sha256 摘要
  const adapterPath = fileURLToPath(new URL("../../dist/gateway-rpc-adapter.js", import.meta.url));
  const agentScript = fileURLToPath(new URL("../../examples/rpc-file-agent.mjs", import.meta.url));
  const rpcStateDir = join(directory, "rpc-state");
  const rpcOptions = {
    transport: "stdio",
    command: process.execPath,
    args: [agentScript, "--directory", rpcStateDir, "--workspace", directory],
  };

  const config = {
    apps: {
      maybeclaw: {
        version: 2,
        agents: [
          {
            id: "file-agent",
            name: "文件计算助手",
            adapter: "module",
            module: adapterPath,
            options: rpcOptions,
            enabled: true,
          }
        ],
        access: {
          creators: [],
          deniedUsers: [],
          sessionAdmins: {},
          allowedAgents: {},
        },
        server: {
          maxConcurrent: 4,
          approvalMs: 60000,
          idleMs: 120000,
          shutdownMs: 15000,
          auth: { password },
          publicOrigin: "https://gateway.example.com",
        }
      }
    }
  };
  await writeFile(path, JSON.stringify(config, null, 2));

  // 2. 在工作区中写入真实计算目标文件
  const testFileName = "compute-target.txt";
  const testFileContent = "真实文件内容，供 RPC 文件 Agent 子进程执行 sha256 运算验证。\n";
  await writeFile(join(directory, testFileName), testFileContent, "utf8");
  const expectedHash = createHash("sha256").update(testFileContent).digest("hex");

  // 3. 启动 AgentGateway，通过正式 API 创建会话并调用真实子进程执行任务
  const gateway = new AgentGateway({ directory, configPath: path, settings: gatewaySettings(config) });

  let browser, server;
  t.after(async () => {
    await browser?.close();
    if (server) await server.close(); else await gateway.close();
    const child = relative(base, directory);
    assert.ok(child && !child.startsWith(".."));
    await rm(directory, { recursive: true, force: true });
  });

  const session = gateway.createSession({ kind: "operator", id: "tester" }, "真实文件计算会话", ["file-agent"]);
  assert.ok(session.id);

  const inputMessage = JSON.stringify({ operation: "sha256", path: testFileName });
  const handleResult = await gateway.handle(inputMessage, { kind: "operator", id: "tester" }, { requestId: "req-compute-1", sessionId: session.id });
  assert.equal(handleResult.sessionId, session.id);

  // 等待后台真实子进程任务执行完毕
  let completedTask;
  for (let attempt = 0; attempt < 100; attempt++) {
    const tasks = gateway.store.list("tasks").filter(t => t.sessionId === session.id);
    if (tasks.length > 0 && tasks[0].status === "completed") {
      completedTask = tasks[0];
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(completedTask, "真实子进程 Agent 任务应当在超时前执行完成");
  assert.equal(completedTask.agentId, "file-agent");

  // 验证真实计算结果已保存为会话消息
  const sessionMessages = gateway.messages(session.id, { kind: "operator", id: "tester" });
  assert.ok(sessionMessages.some(m => m.text.includes(expectedHash)), "真实子进程应当计算并返回正确的 sha256 摘要结果");

  // 4. 启动服务与 Playwright 浏览器
  server = await startGatewayServer({ gateway, port: 0 });
  browser = await chromium.launch({ headless: true, env: { ...process.env, TEMP: directory, TMP: directory, TMPDIR: directory } });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));

  await page.goto(server.url);

  // 5. 登录管理端
  await page.locator(".connection-button").click();
  await page.getByLabel("管理员密码", { exact: true }).fill(password);
  const initialSnapshotResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/ui/snapshot" && response.status() === 200);
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".new-button")?.disabled);

  assert.equal((await (await initialSnapshotResponse).json()).selectedId, null);
  assert.equal(await page.locator(".resource-item.selected").count(), 0);
  const composer = page.getByLabel("消息输入", { exact: true });
  const sendButton = page.getByRole("button", { name: "发送消息", exact: true });
  const cancelButton = page.locator(".stop-button");
  await composer.fill(inputMessage);
  assert.equal(await sendButton.isVisible(), true);
  assert.equal(await sendButton.isDisabled(), true);
  assert.equal(await cancelButton.isVisible(), false);
  await composer.fill("/status");
  await page.waitForFunction(() => document.querySelector("button[aria-label='发送消息']")?.disabled === false);
  assert.equal(await sendButton.isEnabled(), true);

  const initialTaskIds = gateway.store.list("tasks").map(task => task.id).sort();
  const statusText = `/status ${completedTask.id}`;
  await composer.fill(statusText);
  const statusResponsePending = page.waitForResponse(response => new URL(response.url()).pathname === "/api/ui/commands" && response.request().method() === "POST");
  await sendButton.click();
  const statusResponse = await statusResponsePending;
  assert.equal(statusResponse.status(), 200);
  const statusCommand = statusResponse.request().postDataJSON();
  assert.equal(statusCommand.name, "gateway.command");
  assert.equal(statusCommand.args.text, statusText);
  assert.equal(statusCommand.targetId, null);
  const statusReceipt = await statusResponse.json();
  assert.ok(statusReceipt.output.text.includes(completedTask.id));
  assert.ok(statusReceipt.output.text.includes("completed"));
  assert.equal(statusReceipt.selectedId, session.id);
  assert.deepEqual(gateway.store.list("tasks").map(task => task.id).sort(), initialTaskIds);
  await page.waitForFunction(() => document.querySelector("textarea[aria-label='消息输入']")?.value === "");

  // 6. 验证侧栏类型化分组导航
  const nav = page.locator(".sidebar-navigation");
  await nav.waitFor({ state: "visible" });

  const groupTitles = await nav.locator(".nav-group-title").allTextContents();
  assert.ok(groupTitles.includes("会话管理"));
  assert.ok(groupTitles.includes("Agent 与任务"));
  assert.ok(groupTitles.includes("渠道与系统"));

  // 7. 验证“执行任务”真实任务展示与切换会话功能
  await page.getByRole("button", { name: "执行任务", exact: true }).click();
  const tasksDialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "执行任务与协同", exact: true }) });
  await tasksDialog.waitFor({ state: "visible" });
  await tasksDialog.locator(".gateway-summary-bar").waitFor({ state: "visible" });
  const tasksSummary = await tasksDialog.locator(".gateway-summary-bar").textContent();
  assert.ok(tasksSummary.includes("总任务数：1"));
  assert.ok(tasksSummary.includes("运行中：0"));

  // 验证真实任务卡片展示真实 ID 与 Agent 及已完成状态
  const taskTitle = await tasksDialog.locator(".gateway-card-title").first().textContent();
  assert.ok(taskTitle.includes(completedTask.id.slice(0, 16)));
  assert.ok(taskTitle.includes("file-agent"));
  const taskStatus = await tasksDialog.locator(".gateway-status-pill").first().textContent();
  assert.equal(taskStatus, "[已完成]");

  // 验证任务卡片上的“切换到该会话”按钮
  const switchSessionButton = tasksDialog.getByRole("button", { name: "切换到该会话", exact: true }).first();
  await switchSessionButton.waitFor({ state: "visible" });
  await switchSessionButton.click();
  await tasksDialog.waitFor({ state: "detached" });

  // 验证选择会话后主界面会话呈现
  await page.waitForFunction((sessionName) => {
    const active = document.querySelector(".sidebar-item.selected, .sidebar-item.active, .resource-item.selected, .resource-item.active");
    return active?.textContent?.includes(sessionName);
  }, session.name);

  await sendButton.waitFor({ state: "visible" });
  assert.equal(await sendButton.isDisabled(), true);
  assert.equal(await cancelButton.isVisible(), false);
  await composer.fill(inputMessage);
  await page.waitForFunction(() => document.querySelector("button[aria-label='发送消息']")?.disabled === false);
  assert.equal(await sendButton.isVisible(), true);
  assert.equal(await sendButton.isEnabled(), true);
  assert.equal(await cancelButton.isVisible(), false);
  await composer.fill("");

  // 8. 验证“服务设置”真实配置字段
  await page.getByRole("button", { name: "服务设置", exact: true }).click();
  const settingsDialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "服务设置", exact: true }) });
  await settingsDialog.waitFor({ state: "visible" });
  const settingsSummary = await settingsDialog.locator(".gateway-summary-bar").textContent();
  assert.ok(settingsSummary.includes(`最大并发：${gateway.options.settings.maxConcurrent}`));
  assert.ok(settingsSummary.includes(`配置 Agent：${gateway.options.settings.agents.length}`));

  const settingsMeta = await settingsDialog.locator(".gateway-card-meta").textContent();
  assert.ok(settingsMeta.includes(`反向代理公网来源：${gateway.options.settings.publicOrigin ?? "未配置反向代理公网来源"}`));
  assert.ok(settingsMeta.includes(`最大并发任务数：${gateway.options.settings.maxConcurrent} 项`));
  assert.ok(settingsMeta.includes(`空闲释放超时：${gateway.options.settings.idleMs} ms`));
  assert.ok(settingsMeta.includes(`审批等待超时：${gateway.options.settings.approvalMs} ms`));
  assert.ok(settingsMeta.includes(`创建权限限制人数：${gateway.options.settings.access?.creators?.length ?? 0} 人`));
  assert.ok(settingsMeta.includes(`禁止访问名单人数：${gateway.options.settings.access?.deniedUsers?.length ?? 0} 人`));

  const settingsDiagSummary = settingsDialog.locator(".gateway-diag summary");
  await settingsDiagSummary.waitFor({ state: "visible" });
  assert.equal(await settingsDiagSummary.textContent(), "原始服务设置数据（JSON）");

  await page.keyboard.press("Escape");
  await settingsDialog.waitFor({ state: "detached" });

  // 9. 验证“聊天渠道”实际空投递状态展示（不调用外部真实平台）
  await page.getByRole("button", { name: "聊天渠道", exact: true }).click();
  const channelsDialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "聊天渠道", exact: true }) });
  await channelsDialog.waitFor({ state: "visible" });
  const channelsSummary = await channelsDialog.locator(".gateway-summary-bar").textContent();
  assert.ok(channelsSummary.includes("消息投递：0"));
  assert.ok(channelsSummary.includes("绑定入口：0"));

  await page.keyboard.press("Escape");
  await channelsDialog.waitFor({ state: "detached" });

  // 10. 验证“会话筛选”结构化面板与状态标签
  await page.getByRole("button", { name: "会话筛选", exact: true }).click();
  const sessionsDialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "会话筛选", exact: true }) });
  await sessionsDialog.waitFor({ state: "visible" });
  await sessionsDialog.getByLabel("搜索会话名称", { exact: true }).waitFor({ state: "visible" });
  await sessionsDialog.getByLabel("筛选会话状态", { exact: true }).waitFor({ state: "visible" });

  await page.keyboard.press("Escape");
  await sessionsDialog.waitFor({ state: "detached" });

  // 11. 在较矮高度与窄屏视口（320x568、390x844 与 768x500）下打开 Gateway 管理窗口并验证控件位于可滚动区域
  const responsiveTestSizes = [
    { width: 320, height: 568, name: "320x568 矮窄屏" },
    { width: 390, height: 844, name: "390x844 标准移动屏幕" },
    { width: 768, height: 500, name: "768x500 矮平板" },
  ];

  for (const size of responsiveTestSizes) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.waitForTimeout(100);

    // 窄屏抽屉若处于收起状态，先展开侧栏抽屉
    const sidebar = page.locator(".sidebar");
    const isSidebarVisible = await sidebar.evaluate(el => !el.inert && !el.hasAttribute("aria-hidden"));
    if (!isSidebarVisible) {
      const toggle = page.getByRole("button", { name: "切换侧边栏" });
      await toggle.click();
      await page.waitForFunction(() => document.querySelector(".workbench")?.classList.contains("sidebar-open"));
    }

    // 打开“服务设置”管理窗口
    const settingsNavBtn = page.getByRole("button", { name: "服务设置", exact: true });
    await settingsNavBtn.waitFor({ state: "visible" });
    await settingsNavBtn.scrollIntoViewIfNeeded();
    await settingsNavBtn.click();
    const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "服务设置", exact: true }) });
    await dialog.waitFor({ state: "visible" });

    // 检查表单容器具有竖向滚动能力
    const scrollInfo = await dialog.locator(".gateway-dialog-form").evaluate(el => {
      const computed = window.getComputedStyle(el);
      return {
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        overflowY: computed.overflowY,
      };
    });
    assert.ok(scrollInfo.scrollHeight >= scrollInfo.clientHeight, `${size.name} 表单内部内容高度异常`);
    assert.equal(scrollInfo.overflowY, "auto", `${size.name} 表单未配置竖向自动滚动`);

    // 检查底部关闭按钮可滚动到视口内并可点击关闭
    const closeBtn = dialog.getByRole("button", { name: "关闭", exact: true });
    await closeBtn.scrollIntoViewIfNeeded();
    await closeBtn.click();
    await dialog.waitFor({ state: "detached" });
  }

  // 12. 在 320px、390px、768px、1440px 视口下验证无页面横向滚动溢出
  const viewports = [
    { width: 320, height: 600, name: "320px 窄屏" },
    { width: 390, height: 844, name: "390px 标准移动屏幕" },
    { width: 768, height: 1024, name: "768px 平板" },
    { width: 1440, height: 900, name: "1440px 宽屏桌面" },
  ];

  for (const vp of viewports) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.waitForTimeout(50);

    const hasHorizontalOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    assert.equal(hasHorizontalOverflow, false, `${vp.name} 存在视口横向滚动溢出`);
  }

  assert.equal(errors.length, 0, `浏览器控制台存在未捕获错误: ${errors.join("; ")}`);
});
