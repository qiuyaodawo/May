import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AgentWorkspace, defineAgent } from "@may/application";
import { OpenAIResponsesModel } from "@may/provider-openai";
import { InMemorySessionStore } from "@may/session";
import { InMemorySessionCatalog } from "@may/session/catalog";
import { ApplicationUiHost } from "@may/ui-client/application";
import { startUiServer } from "@may/ui-client/server";
import { chromium } from "playwright";
import { webUiAssets } from "../../dist/assets.js";

test("阅读器等长更新未读提示与增量 DOM 渲染真实浏览器集成测试", { timeout: 120_000 }, async t => {
  const base = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../review/web-ui-browser");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "reading-incremental-"));
  let app, server, browser;
  const temporaryVariables = Object.fromEntries(["TMP", "TEMP", "TMPDIR"].map(key => [key, process.env[key]]));
  for (const key of Object.keys(temporaryVariables)) process.env[key] = directory;

  t.after(async () => {
    await browser?.close();
    await server?.close();
    await app?.close();
    for (const [key, value] of Object.entries(temporaryVariables)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    const child = relative(base, directory);
    assert.ok(child && !child.startsWith(".."));
    await rm(directory, { recursive: true, force: true });
  });

  const store = new InMemorySessionStore();
  const catalog = new InMemorySessionCatalog();
  const definition = defineAgent({
    model: new OpenAIResponsesModel({ apiKey: randomBytes(32).toString("hex"), model: "gpt-4.1", baseURL: "http://127.0.0.1:1/v1" }),
    permissionPolicy: () => "deny", sessionHistory: false, providerNativeAutoCompaction: false, autoCompactionStrategies: [],
  });

  app = await AgentWorkspace.open({
    workspace: directory, store, catalog,
    openApplication: selection => definition.open({ ...selection, store }),
  });

  const sessionId = app.sessionId;
  const appendEvent = async (payload) => {
    const events = await store.read(sessionId);
    await store.append({
      sessionId,
      seq: events.length + 1,
      timestamp: Date.now(),
      ...payload,
    });
  };

  // 使用会话存储和生产投影路径回放 150 轮历史测试数据。
  for (let r = 1; r <= 150; r++) {
    const runId = `run-history-${r}`;
    await appendEvent({
      type: "input.submitted",
      message: { role: "user", content: [{ type: "text", text: `第 ${r} 轮用户历史提示词指令` }] },
    });
    await appendEvent({
      type: "run.started",
      runId,
    });
    const callId = `call-tool-${r}`;
    await appendEvent({
      type: "tool.started",
      runId,
      step: 1,
      call: { id: callId, name: "system.query", input: { id: r } },
    });
    await appendEvent({
      type: "tool.presentation",
      runId,
      step: 1,
      toolCallId: callId,
      kind: "system.metric",
      version: 1,
      data: { status: "ACTIVE_VAL_A" },
    });
    await appendEvent({
      type: "tool.completed",
      runId,
      step: 1,
      call: { id: callId, name: "system.query", input: { id: r } },
      output: `执行完成 ${r}`,
    });
    await appendEvent({
      type: "assistant.completed",
      runId,
      step: 2,
      message: { role: "assistant", content: [{ type: "text", text: `助手对第 ${r} 轮指令的说明输出内容文本。` }] },
    });
    await appendEvent({
      type: "run.completed",
      runId,
      result: { status: "completed" },
    });
  }

  const host = new ApplicationUiHost(app, {
    product: { id: "reading-test", title: "阅读器测试", subtitle: "测试等长更新与增量 DOM", resourceKind: "session", suggestions: [] },
  });

  const rawAssets = await webUiAssets("阅读器测试", "session", { browserLogin: true });
  const assetsMap = new Map(rawAssets);

  const appScript = `
    import { UiClient } from "/ui/client.js";
    import { mountWebUI } from "/webui/index.js";
    import { browserLogin } from "/webui/browser-login.js";

    const client = new UiClient();
    const root = document.getElementById("app");

    mountWebUI(root, client, {
      title: "阅读器测试",
      kind: "session",
      initialToken: browserLogin(),
    });

    window.__testClient = client;
  `;
  assetsMap.set("/app.js", { type: "text/javascript; charset=utf-8", body: appScript });

  server = await startUiServer({
    host,
    assets: assetsMap,
    token: randomBytes(32).toString("hex"),
    browserLogin: true,
    port: 0,
    close: () => host.close(),
  });

  browser = await chromium.launch({ headless: true, artifactsDir: directory, downloadsPath: directory });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));

  await page.goto(server.createLoginUrl());
  await page.locator(".workbench").waitFor({ state: "visible" });

  // 2. 通过循环点击“加载更早记录”直至全部 450 块完全显示
  await page.waitForFunction(() => document.querySelectorAll(".run-group").length > 0);
  const loadMoreButton = page.getByRole("button", { name: "加载更早记录" });
  while (await loadMoreButton.isVisible()) {
    await loadMoreButton.click();
    await page.waitForTimeout(50);
  }

  const loadedBlockCount = await page.locator("article[data-id]").count();
  assert.equal(loadedBlockCount, 450, "通过加载更早记录后页面应当展示全部 450 块历史记录");
  console.log(`已加载全部历史记录区块数量: ${loadedBlockCount}`);

  // 3. 将滚动容器滚动离开底部，使阅读器进入非跟随状态（following: false）
  await page.evaluate(() => {
    const scrollContainer = document.querySelector(".conversation-scroll");
    if (scrollContainer) {
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));
    }
  });
  await page.waitForTimeout(50);

  // 4. 挂载 MutationObserver 观察后续 DOM 变更
  await page.evaluate(() => {
    window.__domMutations = [];
    const observer = new MutationObserver(mutations => {
      for (const m of mutations) {
        if (m.type === "childList") {
          window.__domMutations.push({
            type: "childList",
            addedNodes: m.addedNodes.length,
            removedNodes: m.removedNodes.length,
          });
        }
      }
    });
    const messages = document.querySelector(".messages");
    if (messages) {
      observer.observe(messages, { childList: true, subtree: true });
    }
  });

  // 5. 验证过滤器开关不标记新内容
  const onlyErrorsCheckbox = page.getByLabel("只看异常");
  await onlyErrorsCheckbox.check();
  await page.waitForTimeout(50);
  assert.equal(await page.locator("button:has-text('有新内容 · 回到最新')").count(), 0, "切换开启异常过滤器不应标记未读内容");

  await onlyErrorsCheckbox.uncheck();
  await page.waitForTimeout(50);
  assert.equal(await page.locator("button:has-text('有新内容 · 回到最新')").count(), 0, "切换关闭异常过滤器不应标记未读内容");

  // 6. 验证真实 session.rename 命令导致 busy 更新后不标记新内容
  await page.evaluate(async sid => {
    await window.__testClient.command("session.rename", { title: "已重命名的历史回放会话" }, sid);
  }, sessionId);
  await page.waitForTimeout(100);
  assert.equal(await page.locator("button:has-text('有新内容 · 回到最新')").count(), 0, "执行 session.rename 命令导致 busy 更新后不应标记未读内容");

  // 7. 验证重复 HTTP 快照刷新时的 DOM 稳定性
  const baselineBeforeRefresh = await page.evaluate(() => window.__domMutations.length);
  await page.evaluate(async () => {
    await window.__testClient.refresh();
  });
  await page.waitForTimeout(50);

  const baselineMutations = (await page.evaluate(() => window.__domMutations.length)) - baselineBeforeRefresh;
  assert.equal(baselineMutations, 0, "重复获取相同快照时原有 DOM 节点应当完全保持稳定");
  console.log(`相同快照刷新后 MutationObserver 记录子节点变动次数: ${baselineMutations}`);

  // 8. 追加等长内容修改（字符总长度完全一致，内容从 ACTIVE_VAL_A 变为 ACTIVE_VAL_B）
  assert.equal(await page.evaluate(() => window.__testClient.state.snapshot.blocks.some(block => block.kind === "tool" && block.runId === "run-history-150")), true, "待更新记录必须位于当前实时快照中");
  const beforeUpdateMutationCount = await page.evaluate(() => window.__domMutations.length);
  await appendEvent({
    type: "tool.presentation",
    runId: "run-history-150",
    step: 1,
    toolCallId: "call-tool-150",
    kind: "system.metric",
    version: 1,
    data: { status: "ACTIVE_VAL_B" },
  });

  // 通知宿主状态变动，客户端通过真实 HTTP refresh 获取新快照
  host.changed();
  await page.evaluate(async () => {
    await window.__testClient.refresh();
  });
  await page.waitForTimeout(100);

  // 9. 验证“有新内容 · 回到最新”未读提示可见
  const latestButton = page.getByRole("button", { name: "有新内容 · 回到最新", exact: true });
  await latestButton.waitFor({ state: "visible" });
  assert.equal(await latestButton.textContent(), "有新内容 · 回到最新");

  // 10. 测量增量渲染节点变动：输出 MutationObserver 计数
  const totalMutations = await page.evaluate(() => window.__domMutations.length);
  const updateMutations = totalMutations - beforeUpdateMutationCount;
  console.log(`等长更新后 MutationObserver 记录子节点变动次数: ${updateMutations}`);
  assert.ok(updateMutations > 0, "等长内容变动应当触发目标节点 DOM 更新");
  assert.ok(updateMutations < 10, "等长内容变动应当仅替换局部节点，不应重建整个消息列表");

  // 11. 点击“回到最新”按钮，阅读器恢复跟随并关闭提示
  await latestButton.click();
  await latestButton.waitFor({ state: "detached" });

  assert.equal(errors.length, 0, `浏览器控制台存在未捕获错误: ${errors.join("; ")}`);
});
