import assert from "node:assert/strict";
import { testOutputRoot } from "@sortedyuan/test-support";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { after, before, describe, test } from "node:test";
import { AgentWorkspace, defineAgent } from "@sortedyuan/may";
import { OpenAIResponsesModel } from "@sortedyuan/providers/openai";
import { InMemorySessionStore } from "@sortedyuan/may/session";
import { InMemorySessionCatalog } from "@sortedyuan/may/session/catalog";
import { ApplicationUiHost } from "@sortedyuan/ui-client/application";
import { startUiServer } from "@sortedyuan/ui-client/server";
import { chromium } from "playwright";
import { webUiAssets } from "../../dist/assets.js";

// 注入包含类型化导航与 onNew 回调的应用入口脚本
const appScript = `
  import { UiClient } from "/ui/client.js";
  import { mountWebUI } from "/webui/index.js";
  import { browserLogin } from "/webui/browser-login.js";

  const client = new UiClient();
  const root = document.getElementById("app");

  let actionCount = 0;
  let renderCalls = 0;
  let updateCalls = 0;
  let disposeCalls = 0;

  const testNavigation = {
    groups: [
      {
        id: "ops",
        title: "运维操作",
        items: [
          {
            id: "ping-op",
            label: "执行检查",
            icon: "gear",
            action(ctx) {
              actionCount++;
              const note = document.createElement("div");
              note.id = "custom-action-result";
              note.textContent = "执行检查已触发：" + actionCount;
              document.body.append(note);
            }
          },
          {
            id: "command-op",
            label: "命令操作",
            icon: "plus",
            action(ctx) {
              return ctx.command("session.new");
            }
          }
        ]
      }
    ],
    render(container, ctx) {
      renderCalls++;
      const customEl = document.createElement("div");
      customEl.id = "custom-rendered-nav";
      customEl.textContent = "自定义扩展已挂载";
      container.append(customEl);
      return {
        update(nextState) {
          updateCalls++;
          customEl.setAttribute("data-updates", String(updateCalls));
        },
        dispose() {
          disposeCalls++;
          customEl.remove();
        }
      };
    }
  };

  let syncUpdateCalls = 0;

  const unmount = mountWebUI(root, client, {
    title: "响应式验证",
    kind: "session",
    initialToken: browserLogin(),
    newLabel: "新建测试会话",
    onNew(ctx) {
      if (window.__triggerOnNewError === "sync") {
        throw new Error("测试 onNew 同步抛出错误");
      }
      if (window.__triggerOnNewError === "async") {
        return Promise.reject(new Error("测试 onNew 异步拒绝错误"));
      }
      const flag = document.createElement("div");
      flag.id = "custom-new-triggered";
      flag.textContent = "已触发自定义新建回调";
      document.body.append(flag);
    },
    navigation: testNavigation
  });
  syncUpdateCalls = updateCalls;

  window.__testNavStats = () => ({ renderCalls, updateCalls, syncUpdateCalls, disposeCalls });
  window.__unmountWebUI = unmount;
  window.__testClient = client;
`;

const sidebarContainsFocus = () => Boolean(document.getElementById("may-sidebar")?.contains(document.activeElement));

describe("WebUI 响应式布局与类型化导航", { timeout: 120_000 }, () => {
  const base = join(testOutputRoot, "web-ui", "browser");
  const temporaryVariables = Object.fromEntries(["TMP", "TEMP", "TMPDIR"].map(key => [key, process.env[key]]));
  const errors = [];
  let directory, app, server, browser, page;

  before(async () => {
    await mkdir(base, { recursive: true });
    directory = await mkdtemp(join(base, "nav-responsive-"));
    for (const key of Object.keys(temporaryVariables)) process.env[key] = directory;
    const store = new InMemorySessionStore();
    const definition = defineAgent({
      model: new OpenAIResponsesModel({ apiKey: randomBytes(32).toString("hex"), model: "gpt-4.1", baseURL: "http://127.0.0.1:1/v1" }),
      permissionPolicy: () => "deny", sessionHistory: false, providerNativeAutoCompaction: false, autoCompactionStrategies: [],
    });
    app = await AgentWorkspace.open({
      workspace: directory, store, catalog: new InMemorySessionCatalog(),
      openApplication: selection => definition.open({ ...selection, store }),
    });
    await app.renameSession(app.sessionId, "测试初始会话");
    const host = new ApplicationUiHost(app, {
      product: { id: "responsive-test", title: "响应式验证", subtitle: "测试多视口与导航扩展", resourceKind: "session", suggestions: ["建议1"] },
    });
    const assets = new Map(await webUiAssets("响应式验证", "session", { browserLogin: true }));
    assets.set("/app.js", { type: "text/javascript; charset=utf-8", body: appScript });
    server = await startUiServer({ host, assets, token: randomBytes(32).toString("hex"), browserLogin: true, port: 0, close: () => host.close() });
    browser = await chromium.launch({ headless: true, artifactsDir: directory, downloadsPath: directory });
    page = await browser.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(server.createLoginUrl());
    await page.locator(".workbench").waitFor({ state: "visible" });
  });

  after(async () => {
    await browser?.close();
    await server?.close();
    await app?.close();
    for (const [key, value] of Object.entries(temporaryVariables)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (directory !== undefined) {
      const child = relative(base, directory);
      assert.ok(child && !child.startsWith(".."));
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("navigation.render 调用一次，挂载同步阶段 update 调用一次", async () => {
    await page.locator("#custom-rendered-nav").waitFor({ state: "visible" });
    assert.equal(await page.locator("#custom-rendered-nav").textContent(), "自定义扩展已挂载");
    const stats = await page.evaluate(() => window.__testNavStats());
    assert.equal(stats.renderCalls, 1, "navigation.render 应当被调用且仅调用一次");
    assert.equal(stats.syncUpdateCalls, 1, "挂载初始同步阶段 update 应当被调用且仅调用一次");
    assert.ok(stats.updateCalls >= 1, "随着连接建立 update 应当持续收到快照更新");
  });

  test("类型化导航项执行自定义操作", async () => {
    const navContainer = page.locator(".sidebar-navigation");
    await navContainer.waitFor({ state: "visible" });
    assert.equal(await navContainer.locator(".nav-group-title").textContent(), "运维操作");
    await page.locator(".sidebar-nav-item[data-nav-id='ping-op']").click();
    await page.locator("#custom-action-result").waitFor({ state: "visible" });
    assert.equal(await page.locator("#custom-action-result").textContent(), "执行检查已触发：1");
  });

  test("导航项通过 ctx.command 创建宿主会话", async () => {
    await page.locator(".sidebar-nav-item[data-nav-id='command-op']").click();
    await page.waitForFunction(() => document.querySelectorAll(".resource-item").length === 2);
  });

  test("新建按钮调用自定义 onNew", async () => {
    await page.getByRole("button", { name: "新建测试会话", exact: true }).click();
    await page.locator("#custom-new-triggered").waitFor({ state: "visible" });
  });

  for (const mode of ["sync", "async"]) {
    test(`onNew ${mode === "sync" ? "同步抛出" : "异步拒绝"}的错误显示在浮层中，Escape 关闭浮层`, async () => {
      await page.evaluate(value => { window.__triggerOnNewError = value; }, mode);
      try {
        await page.getByRole("button", { name: "新建测试会话", exact: true }).click();
        const banner = page.locator(".error-banner");
        await banner.waitFor({ state: "visible" });
        assert.ok((await banner.textContent()).includes(mode === "sync" ? "测试 onNew 同步抛出错误" : "测试 onNew 异步拒绝错误"));
        await page.keyboard.press("Escape");
        await banner.waitFor({ state: "hidden" });
      } finally {
        await page.evaluate(() => { window.__triggerOnNewError = null; });
      }
    });
  }

  for (const viewport of [
    { width: 320, height: 600, name: "320px 窄屏移动设备" },
    { width: 390, height: 844, name: "390px 标准移动设备" },
    { width: 768, height: 1024, name: "768px 平板设备" },
    { width: 1440, height: 900, name: "1440px 桌面显示器" },
  ]) {
    test(`${viewport.name}没有页面横向滚动`, async () => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.waitForTimeout(50);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    });
    if (viewport.width > 760) continue;

    test(`${viewport.name}隐藏的侧栏不可聚焦`, async () => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      assert.equal(await page.evaluate(() => {
        const sidebar = document.getElementById("may-sidebar");
        return Boolean(sidebar?.inert && sidebar?.getAttribute("aria-hidden") === "true");
      }), true, "移动端隐藏侧栏时缺少 inert 或 aria-hidden");
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(sidebarContainsFocus), false, "移动端侧栏隐藏时焦点误入侧栏控件");
    });

    test(`${viewport.name}展开的侧栏把 Tab 焦点限制在侧栏内`, async () => {
      await page.locator(".icon-button[aria-label='切换侧边栏']").click();
      await page.waitForTimeout(50);
      assert.equal(await page.evaluate(() => Boolean(document.getElementById("may-sidebar")?.inert)), false, "展开侧栏后 inert 属性未清除");
      assert.equal(await page.evaluate(sidebarContainsFocus), true, "展开侧栏后键盘焦点未移入侧栏");
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(sidebarContainsFocus), true, "侧栏内 Tab 键移动后焦点脱离侧栏");
      await page.keyboard.press("Shift+Tab");
      assert.equal(await page.evaluate(sidebarContainsFocus), true, "侧栏内 Shift+Tab 键移动后焦点脱离侧栏");
      const firstControl = await page.evaluate(() => {
        const controls = Array.from(document.querySelectorAll("#may-sidebar button, #may-sidebar input, #may-sidebar [tabindex]")).filter(control => control.tabIndex >= 0 && !control.matches(":disabled") && control.getClientRects().length > 0);
        controls.at(-1).focus();
        return controls[0].outerHTML;
      });
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement.outerHTML), firstControl, "Tab 应从侧栏最后一个控件返回第一个控件");
      await page.keyboard.press("Shift+Tab");
      assert.equal(await page.evaluate(() => {
        const controls = Array.from(document.querySelectorAll("#may-sidebar button, #may-sidebar input, #may-sidebar [tabindex]")).filter(control => control.tabIndex >= 0 && !control.matches(":disabled") && control.getClientRects().length > 0);
        return document.activeElement === controls.at(-1);
      }), true, "Shift+Tab 应从侧栏第一个控件返回最后一个控件");
    });

    test(`${viewport.name}侧栏遮罩挡住正文控件`, async () => {
      assert.equal(await page.evaluate(() => {
        const backdrop = document.querySelector(".mobile-backdrop");
        return Boolean(backdrop && !backdrop.hidden);
      }), true, "移动端侧栏打开时遮罩未呈现");
      const hitClassName = await page.evaluate(() => {
        const rect = document.querySelector(".icon-button[aria-label='显示或隐藏详情']")?.getBoundingClientRect();
        return rect && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.className;
      });
      assert.ok(hitClassName?.includes("mobile-backdrop") || hitClassName?.includes("sidebar"), "遮罩未成功覆盖在正文上方阻断穿透");
    });

    test(`${viewport.name}Escape 关闭侧栏并把焦点还给切换按钮`, async () => {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(50);
      assert.equal(await page.evaluate(() => !document.querySelector(".workbench")?.classList.contains("sidebar-open")), true, "按 Escape 未关闭移动端侧栏");
      assert.equal(await page.evaluate(() => document.activeElement === document.querySelector(".icon-button[aria-label='切换侧边栏']")), true, "关闭侧栏后焦点未恢复至切换按钮");
    });
  }

  test("详情抽屉接收焦点，Escape 关闭后焦点回到详情按钮", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator(".icon-button[aria-label='显示或隐藏详情']").click();
    await page.locator(".workbench.details-open").waitFor({ state: "visible" });
    assert.equal(await page.evaluate(() => Boolean(document.querySelector(".details-panel")?.contains(document.activeElement))), true, "展开详情面板后键盘焦点未移入面板");
    await page.keyboard.press("Escape");
    await page.locator(".workbench:not(.details-open)").waitFor({ state: "visible" });
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector(".icon-button[aria-label='显示或隐藏详情']")), true, "关闭详情抽屉后焦点未恢复至详情按钮");
  });

  test("重复卸载只调用一次 navigation dispose", async () => {
    await page.evaluate(() => {
      window.__unmountWebUI();
      window.__unmountWebUI();
    });
    assert.equal((await page.evaluate(() => window.__testNavStats())).disposeCalls, 1, "navigation.render 返回的 dispose 应当被调用且仅调用一次");
  });

  test("页面没有未捕获的异常", () => {
    assert.equal(errors.length, 0, `浏览器控制台存在未捕获异常: ${errors.join("; ")}`);
  });
});
