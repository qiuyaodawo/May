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

test("WebUI 响应式布局与类型化导航集成测试", { timeout: 120_000 }, async t => {
  const base = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../review/web-ui-browser");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "nav-responsive-"));
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
  await app.renameSession(app.sessionId, "测试初始会话");

  const host = new ApplicationUiHost(app, {
    product: { id: "responsive-test", title: "响应式验证", subtitle: "测试多视口与导航扩展", resourceKind: "session", suggestions: ["建议1"] },
  });

  const rawAssets = await webUiAssets("响应式验证", "session", { browserLogin: true });
  const assetsMap = new Map(rawAssets);

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

  // 1. 验证 navigation.render 真实调用与首次 update 仅执行一次
  await page.locator("#custom-rendered-nav").waitFor({ state: "visible" });
  assert.equal(await page.locator("#custom-rendered-nav").textContent(), "自定义扩展已挂载");

  const initialStats = await page.evaluate(() => window.__testNavStats());
  assert.equal(initialStats.renderCalls, 1, "navigation.render 应当被调用且仅调用一次");
  assert.equal(initialStats.syncUpdateCalls, 1, "挂载初始同步阶段 update 应当被调用且仅调用一次");
  assert.ok(initialStats.updateCalls >= 1, "随着连接建立 update 应当持续收到快照更新");

  // 2. 验证类型化导航渲染与触发
  const navContainer = page.locator(".sidebar-navigation");
  await navContainer.waitFor({ state: "visible" });
  assert.equal(await navContainer.locator(".nav-group-title").textContent(), "运维操作");

  const actionButton = page.locator(".sidebar-nav-item[data-nav-id='ping-op']");
  await actionButton.waitFor({ state: "visible" });
  await actionButton.click();
  await page.locator("#custom-action-result").waitFor({ state: "visible" });
  assert.equal(await page.locator("#custom-action-result").textContent(), "执行检查已触发：1");

  // 验证通过 ctx.command("session.new") 触发宿主会话变化（会话列表增加）
  const commandButton = page.locator(".sidebar-nav-item[data-nav-id='command-op']");
  await commandButton.click();
  await page.waitForFunction(() => {
    return document.querySelectorAll(".resource-item").length === 2;
  });

  // 3. 验证自定义 onNew 按钮点击及错误呈现
  const newButton = page.getByRole("button", { name: "新建测试会话", exact: true });
  await newButton.waitFor({ state: "visible" });
  await newButton.click();
  await page.locator("#custom-new-triggered").waitFor({ state: "visible" });

  // 验证 onNew 同步抛错展示错误浮层
  await page.evaluate(() => { window.__triggerOnNewError = "sync"; });
  await newButton.click();
  const syncError = page.locator(".error-banner");
  await syncError.waitFor({ state: "visible" });
  assert.ok((await syncError.textContent()).includes("测试 onNew 同步抛出错误"));

  // 按 Escape 关闭错误浮层
  await page.keyboard.press("Escape");
  await syncError.waitFor({ state: "hidden" });

  // 验证 onNew 异步抛错展示错误浮层
  await page.evaluate(() => { window.__triggerOnNewError = "async"; });
  await newButton.click();
  const asyncError = page.locator(".error-banner");
  await asyncError.waitFor({ state: "visible" });
  assert.ok((await asyncError.textContent()).includes("测试 onNew 异步拒绝错误"));
  await page.keyboard.press("Escape");
  await asyncError.waitFor({ state: "hidden" });
  await page.evaluate(() => { window.__triggerOnNewError = null; });

  // 4. 在 320px、390px、768px、1440px 视口下验证无页面横向滚动溢出与键盘/可访问性
  const viewports = [
    { width: 320, height: 600, name: "320px 窄屏移动设备" },
    { width: 390, height: 844, name: "390px 标准移动设备" },
    { width: 768, height: 1024, name: "768px 平板设备" },
    { width: 1440, height: 900, name: "1440px 桌面显示器" },
  ];

  for (const vp of viewports) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.waitForTimeout(50);

    const hasHorizontalOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    assert.equal(hasHorizontalOverflow, false, `${vp.name} 存在视口横向滚动溢出`);

    if (vp.width <= 760) {
      // 移动端：隐藏时验证 inert 与 aria-hidden
      const isSidebarInert = await page.evaluate(() => {
        const sidebar = document.getElementById("may-sidebar");
        return Boolean(sidebar?.inert && sidebar?.getAttribute("aria-hidden") === "true");
      });
      assert.equal(isSidebarInert, true, `${vp.name} 移动端隐藏侧栏时缺少 inert 或 aria-hidden`);

      // 验证隐藏侧栏时 Tab 不进入侧栏任何子元素
      await page.keyboard.press("Tab");
      const activeWhenHidden = await page.evaluate(() => {
        const sidebar = document.getElementById("may-sidebar");
        return Boolean(sidebar?.contains(document.activeElement));
      });
      assert.equal(activeWhenHidden, false, `${vp.name} 移动端侧栏隐藏时焦点误入侧栏控件`);

      // 展开侧栏
      const menuButton = page.locator(".icon-button[aria-label='切换侧边栏']");
      await menuButton.click();
      await page.waitForTimeout(50);

      // 验证展开后焦点移入侧栏控件且 inert 为 false
      const openedInert = await page.evaluate(() => {
        const sidebar = document.getElementById("may-sidebar");
        return Boolean(sidebar?.inert);
      });
      assert.equal(openedInert, false, `${vp.name} 展开侧栏后 inert 属性未清除`);

      const activeInSidebar = await page.evaluate(() => {
        const sidebar = document.getElementById("may-sidebar");
        return Boolean(sidebar?.contains(document.activeElement));
      });
      assert.equal(activeInSidebar, true, `${vp.name} 展开侧栏后键盘焦点未移入侧栏`);

      // 验证在侧栏内 Tab 与 Shift+Tab 保持在侧栏可达控件中
      await page.keyboard.press("Tab");
      const activeAfterTab = await page.evaluate(() => {
        const sidebar = document.getElementById("may-sidebar");
        return Boolean(sidebar?.contains(document.activeElement));
      });
      assert.equal(activeAfterTab, true, `${vp.name} 侧栏内 Tab 键移动后焦点脱离侧栏`);

      await page.keyboard.press("Shift+Tab");
      const activeAfterShiftTab = await page.evaluate(() => {
        const sidebar = document.getElementById("may-sidebar");
        return Boolean(sidebar?.contains(document.activeElement));
      });
      assert.equal(activeAfterShiftTab, true, `${vp.name} 侧栏内 Shift+Tab 键移动后焦点脱离侧栏`);

      const firstControl = await page.evaluate(() => {
        const controls = Array.from(document.querySelectorAll("#may-sidebar button, #may-sidebar input, #may-sidebar [tabindex]")).filter(control => control.tabIndex >= 0 && !control.matches(":disabled") && control.getClientRects().length > 0);
        controls.at(-1).focus();
        return controls[0].outerHTML;
      });
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement.outerHTML), firstControl, `${vp.name} Tab 应从侧栏最后一个控件返回第一个控件`);
      await page.keyboard.press("Shift+Tab");
      assert.equal(await page.evaluate(() => {
        const controls = Array.from(document.querySelectorAll("#may-sidebar button, #may-sidebar input, #may-sidebar [tabindex]")).filter(control => control.tabIndex >= 0 && !control.matches(":disabled") && control.getClientRects().length > 0);
        return document.activeElement === controls.at(-1);
      }), true, `${vp.name} Shift+Tab 应从侧栏第一个控件返回最后一个控件`);

      // 验证移动端遮罩处于可见状态且阻断对正文控件的点击穿透
      const isBackdropVisible = await page.evaluate(() => {
        const backdrop = document.querySelector(".mobile-backdrop");
        return Boolean(backdrop && !backdrop.hidden);
      });
      assert.equal(isBackdropVisible, true, `${vp.name} 移动端侧栏打开时遮罩未呈现`);

      // 尝试点击被遮罩遮挡的正文顶部详情按钮：事件应当被遮罩拦截或无法触发详情展开
      await page.evaluate(() => {
        const detailBtn = document.querySelector(".icon-button[aria-label='显示或隐藏详情']");
        const backdrop = document.querySelector(".mobile-backdrop");
        const rect = detailBtn?.getBoundingClientRect();
        if (rect && backdrop) {
          const topElement = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          window.__hitElementTag = topElement?.className;
        }
      });
      const hitClassName = await page.evaluate(() => window.__hitElementTag);
      assert.ok(hitClassName?.includes("mobile-backdrop") || hitClassName?.includes("sidebar"), `${vp.name} 遮罩未成功覆盖在正文上方阻断穿透`);

      // 验证按 Escape 键关闭侧栏，且焦点准确恢复至切换按钮
      await page.keyboard.press("Escape");
      await page.waitForTimeout(50);
      const isSidebarClosed = await page.evaluate(() => {
        return !document.querySelector(".workbench")?.classList.contains("sidebar-open");
      });
      assert.equal(isSidebarClosed, true, `${vp.name} 按 Escape 未关闭移动端侧栏`);

      const isFocusRestored = await page.evaluate(() => {
        const toggle = document.querySelector(".icon-button[aria-label='切换侧边栏']");
        return document.activeElement === toggle;
      });
      assert.equal(isFocusRestored, true, `${vp.name} 关闭侧栏后焦点未恢复至切换按钮`);
    }
  }

  // 5. 验证详情抽屉展开、键盘焦点进入与 Escape 焦点恢复
  await page.setViewportSize({ width: 1440, height: 900 });
  const detailToggle = page.locator(".icon-button[aria-label='显示或隐藏详情']");
  await detailToggle.click();
  await page.locator(".workbench.details-open").waitFor({ state: "visible" });

  const activeInDetails = await page.evaluate(() => {
    const details = document.querySelector(".details-panel");
    return Boolean(details?.contains(document.activeElement));
  });
  assert.equal(activeInDetails, true, "展开详情面板后键盘焦点未移入面板");

  await page.keyboard.press("Escape");
  await page.locator(".workbench:not(.details-open)").waitFor({ state: "visible" });

  const isDetailFocusRestored = await page.evaluate(() => {
    const toggle = document.querySelector(".icon-button[aria-label='显示或隐藏详情']");
    return document.activeElement === toggle;
  });
  assert.equal(isDetailFocusRestored, true, "关闭详情抽屉后焦点未恢复至详情按钮");

  // 6. 验证 dispose 且仅调用一次
  await page.evaluate(() => {
    window.__unmountWebUI();
    window.__unmountWebUI(); // 幂等验证
  });

  const finalStats = await page.evaluate(() => window.__testNavStats());
  assert.equal(finalStats.disposeCalls, 1, "navigation.render 返回的 dispose 应当被调用且仅调用一次");

  assert.equal(errors.length, 0, `浏览器控制台存在未捕获异常: ${errors.join("; ")}`);
});
