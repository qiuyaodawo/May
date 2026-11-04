import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium } from "playwright";
import { createToolChangePreview } from "@sortedyuan/coding-tools/change-preview";
import { InMemorySessionStore } from "@sortedyuan/may/session";
import { InMemorySessionCatalog } from "@sortedyuan/may/session/catalog";
import { createMaybeCodeWebHost, startMaybeCodeWebServer } from "../../dist/web-ui.js";
import { yoloWorkspace } from "../yolo-support.mjs";

const relativePath =
  "packages/subsystem/very-long-module-directory-path-for-responsive-testing-purposes/component-source-file-name-long.ts";
const toolInput = {
  path: relativePath,
  oldText: "--decrementMarker;",
  newText: "++incrementMarker;\nconst extraFlag = true;",
};

describe("MaybeCode Diff 渲染器", { timeout: 60_000 }, () => {
  const store = new InMemorySessionStore();
  const catalog = new InMemorySessionCatalog();
  const errors = [];
  let app, variables, server, browser, page, preview, previewRegion;

  before(async () => {
    app = await yoloWorkspace({ store, catalog });
    variables = Object.fromEntries(["TMP", "TEMP", "TMPDIR"].map((key) => [key, process.env[key]]));
    for (const key of Object.keys(variables)) process.env[key] = app.workspace;

    const fullPath = join(app.workspace, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(
      fullPath,
      [
        "// 模块初始配置与逻辑",
        "const startOffset = 100;",
        "--decrementMarker;",
        "const baseMultiplier = 3;",
        "const longStatement = 'alpha_beta_gamma_delta_epsilon_zeta_eta_theta_iota_kappa_lambda_mu_nu_xi_omicron_pi_rho_sigma_tau_upsilon';",
        "return startOffset + baseMultiplier;",
        "",
      ].join("\n"),
      "utf-8",
    );
    preview = await createToolChangePreview(app.workspace, "edit", toolInput);
    assert.equal(preview?.status, "ready");

    const appendEvent = async (payload) => {
      const events = await store.read(app.sessionId);
      await store.append({ sessionId: app.sessionId, seq: events.length + 1, timestamp: Date.now(), ...payload });
    };
    const call = { id: "call-edit-1", name: "edit", input: toolInput };
    await appendEvent({ type: "tool.started", runId: "run-edit-1", step: 1, call });
    await appendEvent({
      type: "tool.presentation",
      runId: "run-edit-1",
      step: 1,
      toolCallId: call.id,
      kind: "maybecode.change-preview",
      version: 1,
      data: preview,
    });
    await appendEvent({
      type: "tool.completed",
      runId: "run-edit-1",
      step: 1,
      call,
      output: `已更新文件 ${relativePath}`,
    });

    server = await startMaybeCodeWebServer(createMaybeCodeWebHost(app), {
      token: randomBytes(32).toString("hex"),
      port: 0,
      browserLogin: true,
    });
    browser = await chromium.launch({ headless: true, artifactsDir: app.workspace, downloadsPath: app.workspace });
    page = await browser.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.createLoginUrl());
    previewRegion = page.locator(".evidence-inspector .change-preview");
  });

  after(async () => {
    await browser?.close();
    await server?.close();
    await app?.close();
    for (const [key, value] of Object.entries(variables ?? {})) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("打开工具详情后焦点进入检查器的第一个可用按钮", async () => {
    const inspectButton = page.locator(".inspect-tool").first();
    await inspectButton.waitFor({ state: "visible" });
    await inspectButton.click();
    assert.equal(
      await page.evaluate(() => {
        const firstButton = document.querySelector(".evidence-inspector button:not([disabled])");
        return firstButton !== null && firstButton === document.activeElement;
      }),
      true,
    );
  });

  test("变更预览区域带有区域角色和名称", async () => {
    await previewRegion.waitFor({ state: "visible" });
    assert.equal(await previewRegion.getAttribute("role"), "region");
    assert.equal(await previewRegion.getAttribute("aria-label"), "代码变更预览");
  });

  test("统计徽标显示实际增删行数", async () => {
    assert.equal(await previewRegion.locator(".diff-stat-add").textContent(), `+${preview.additions}`);
    assert.equal(await previewRegion.locator(".diff-stat-remove").textContent(), `-${preview.deletions}`);
  });

  test("只有文件头被标记为头部行", async () => {
    const headerLines = await previewRegion.locator(".diff-header").allTextContents();
    assert.equal(headerLines.length, 2);
    assert.ok(headerLines[0].startsWith("--- "));
    assert.ok(headerLines[1].startsWith("+++ "));
  });

  test("以 ++ 开头的代码行被标记为新增行", async () => {
    const addLines = await previewRegion.locator(".diff-add").allTextContents();
    assert.equal(addLines.length, preview.additions);
    assert.ok(addLines.some((line) => line.includes("++incrementMarker")));
  });

  test("以 -- 开头的代码行被标记为删除行", async () => {
    const removeLines = await previewRegion.locator(".diff-remove").allTextContents();
    assert.equal(removeLines.length, preview.deletions);
    assert.ok(removeLines.some((line) => line.includes("--decrementMarker")));
  });

  test("Diff 内容可以通过键盘聚焦", async () => {
    const diffContent = previewRegion.locator(".diff-content");
    assert.equal(await diffContent.getAttribute("tabindex"), "0");
    await diffContent.focus();
    assert.equal(await diffContent.evaluate((element) => element === document.activeElement), true);
  });

  test("320px 视口没有页面横向滚动，长路径标题不超出视口", async () => {
    await page.setViewportSize({ width: 320, height: 600 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    const captionBox = await previewRegion.locator(".diff-caption").boundingBox();
    assert.ok(captionBox && captionBox.width <= 320);
  });

  test("关闭详情面板后面板隐藏并把焦点还给详情开关", async () => {
    await page.locator(".evidence-inspector button[aria-label='关闭详情面板']").click();
    await page.waitForFunction(() => !document.querySelector(".workbench")?.classList.contains("details-open"));
    const detailsPanel = page.locator(".details-panel");
    assert.equal(await detailsPanel.getAttribute("aria-hidden"), "true");
    assert.equal(await detailsPanel.evaluate((element) => element.inert), true);
    const detailToggle = page.locator("button[aria-label='显示或隐藏详情']");
    assert.equal(await detailToggle.getAttribute("aria-expanded"), "false");
    assert.equal(await detailToggle.evaluate((element) => element === document.activeElement), true);
  });

  test("页面没有未捕获的异常", () => {
    assert.deepEqual(errors, []);
  });
});
