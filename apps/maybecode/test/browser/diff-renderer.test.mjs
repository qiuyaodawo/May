import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { createToolChangePreview } from "@may/coding-tools/change-preview";
import { InMemorySessionStore } from "@may/session";
import { InMemorySessionCatalog, createMaybeCodeWebHost, startMaybeCodeWebServer } from "../../dist/index.js";
import { yoloWorkspace } from "../yolo-support.mjs";

test("MaybeCode Diff 渲染器真实浏览器验证：长路径断行、代码行高亮、增删行数统计、键盘滚动与 320px 视口无溢出", { timeout: 60_000 }, async t => {
  const store = new InMemorySessionStore();
  const catalog = new InMemorySessionCatalog();
  const app = await yoloWorkspace({ store, catalog });

  const variables = Object.fromEntries(["TMP", "TEMP", "TMPDIR"].map(key => [key, process.env[key]]));
  for (const key of Object.keys(variables)) process.env[key] = app.workspace;

  let server, browser;
  t.after(async () => {
    await browser?.close();
    await server?.close();
    await app.close();
    for (const [key, value] of Object.entries(variables)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  // 1. 创建真实临时文件，用于生成合法生产 DTO
  const relativePath = "packages/subsystem/very-long-module-directory-path-for-responsive-testing-purposes/component-source-file-name-long.ts";
  const fullPath = join(app.workspace, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  const initialFileContent = [
    "// 模块初始配置与逻辑",
    "const startOffset = 100;",
    "--decrementMarker;",
    "const baseMultiplier = 3;",
    "const longStatement = 'alpha_beta_gamma_delta_epsilon_zeta_eta_theta_iota_kappa_lambda_mu_nu_xi_omicron_pi_rho_sigma_tau_upsilon';",
    "return startOffset + baseMultiplier;",
    ""
  ].join("\n");
  await writeFile(fullPath, initialFileContent, "utf-8");

  // 2. 通过生产函数 createToolChangePreview 计算真实 DTO
  const toolInput = {
    path: relativePath,
    oldText: "--decrementMarker;",
    newText: "++incrementMarker;\nconst extraFlag = true;",
  };
  const preview = await createToolChangePreview(app.workspace, "edit", toolInput);
  assert.ok(preview && preview.status === "ready", "生产函数 createToolChangePreview 应当成功生成 Diff 预览");

  // 3. 从生产 InMemorySessionStore 读取已有序列号，追加符合规范的合法持久历史事件
  const appendEvent = async (payload) => {
    const events = await store.read(app.sessionId);
    await store.append({
      sessionId: app.sessionId,
      seq: events.length + 1,
      timestamp: Date.now(),
      ...payload,
    });
  };

  const callId = "call-edit-1";
  const runId = "run-edit-1";
  await appendEvent({
    type: "tool.started",
    runId,
    step: 1,
    call: {
      id: callId,
      name: "edit",
      input: toolInput,
    },
  });
  await appendEvent({
    type: "tool.presentation",
    runId,
    step: 1,
    toolCallId: callId,
    kind: "maybecode.change-preview",
    version: 1,
    data: preview,
  });
  await appendEvent({
    type: "tool.completed",
    runId,
    step: 1,
    call: {
      id: callId,
      name: "edit",
      input: toolInput,
    },
    output: `已更新文件 ${relativePath}`,
  });

  const host = createMaybeCodeWebHost(app);
  server = await startMaybeCodeWebServer(host, { token: randomBytes(32).toString("hex"), port: 0, browserLogin: true });
  browser = await chromium.launch({ headless: true, artifactsDir: app.workspace, downloadsPath: app.workspace });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));

  await page.goto(server.createLoginUrl());

  // 4. 浏览器在阅读器中定位工具卡片，点击“查看详情”进入检查器展示产品 Diff
  const inspectButton = page.locator(".inspect-tool").first();
  await inspectButton.waitFor({ state: "visible" });
  await inspectButton.click();

  const isFirstButtonFocused = await page.evaluate(() => {
    const firstButton = document.querySelector(".evidence-inspector button:not([disabled])");
    return firstButton !== null && firstButton === document.activeElement;
  });
  assert.equal(isFirstButtonFocused, true, "打开检查器时应当聚焦检查器内部首个可用按钮");

  // 5. 验证变更预览区域渲染
  const previewRegion = page.locator(".evidence-inspector .change-preview");
  await previewRegion.waitFor({ state: "visible" });
  assert.equal(await previewRegion.getAttribute("role"), "region");
  assert.equal(await previewRegion.getAttribute("aria-label"), "代码变更预览");

  // 6. 验证真实增删统计徽标内容
  const addBadge = previewRegion.locator(".diff-stat-add");
  const removeBadge = previewRegion.locator(".diff-stat-remove");
  assert.equal(await addBadge.textContent(), `+${preview.additions}`);
  assert.equal(await removeBadge.textContent(), `-${preview.deletions}`);

  // 7. 验证头部与代码行的正确区分（消除误将 ++/-- 代码行判定为头部的问题）
  const headerLines = await previewRegion.locator(".diff-header").allTextContents();
  assert.equal(headerLines.length, 2);
  assert.ok(headerLines[0].startsWith("--- "));
  assert.ok(headerLines[1].startsWith("+++ "));

  // 验证 ++incrementMarker 代码行被正确标记为新增行
  const addLines = await previewRegion.locator(".diff-add").allTextContents();
  assert.equal(addLines.length, preview.additions);
  assert.ok(addLines.some(line => line.includes("++incrementMarker")));

  // 验证 --decrementMarker 代码行被正确标记为删除行
  const removeLines = await previewRegion.locator(".diff-remove").allTextContents();
  assert.equal(removeLines.length, preview.deletions);
  assert.ok(removeLines.some(line => line.includes("--decrementMarker")));

  // 8. 验证键盘焦点与无障碍属性及键盘右箭头滚动
  const diffContent = previewRegion.locator(".diff-content");
  assert.equal(await diffContent.getAttribute("tabindex"), "0");
  await diffContent.focus();
  const isFocused = await diffContent.evaluate(el => el === document.activeElement);
  assert.equal(isFocused, true, "diff 预格式容器应当支持键盘聚焦");

  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");

  // 9. 验证 320px 视口无横向溢出且长路径正常断行呈现
  await page.setViewportSize({ width: 320, height: 600 });
  await page.waitForTimeout(100);

  const hasHorizontalOverflow = await page.evaluate(() => {
    return document.documentElement.scrollWidth > window.innerWidth;
  });
  assert.equal(hasHorizontalOverflow, false, "320px 视口下页面存在横向滚动溢出");

  const captionBox = await previewRegion.locator(".diff-caption").boundingBox();
  assert.ok(captionBox && captionBox.width <= 320, "长路径标题容器超出了视口可用宽度");

  // 10. 点击“关闭详情面板”按钮，验证抽屉收起、状态重置及焦点恢复
  const closeDetailsButton = page.locator(".evidence-inspector button[aria-label='关闭详情面板']");
  await closeDetailsButton.click();
  await page.waitForTimeout(50);

  const workbenchHasDetailsOpen = await page.locator(".workbench").evaluate(el => el.classList.contains("details-open"));
  assert.equal(workbenchHasDetailsOpen, false, "关闭详情面板后 workbench 不应包含 details-open 类名");

  const detailsPanel = page.locator(".details-panel");
  assert.equal(await detailsPanel.getAttribute("aria-hidden"), "true", "关闭详情面板后 details 应当设置 aria-hidden='true'");
  const isInert = await detailsPanel.evaluate(el => el.inert);
  assert.equal(isInert, true, "关闭详情面板后 details 应当处于 inert 状态");

  const detailToggle = page.locator("button[aria-label='显示或隐藏详情']");
  assert.equal(await detailToggle.getAttribute("aria-expanded"), "false");
  const isToggleFocused = await detailToggle.evaluate(el => el === document.activeElement);
  assert.equal(isToggleFocused, true, "关闭详情面板后焦点应当恢复到详情开关按钮");

  assert.equal(errors.length, 0, `浏览器控制台存在未捕获错误: ${errors.join("; ")}`);
});
