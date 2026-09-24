import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { chromium } from "playwright";
import { createMaybeCodeWebHost, startMaybeCodeWebServer } from "../../dist/index.js";
import { yoloWorkspace } from "../yolo-support.mjs";

test("WebUI 与 workspace 同步 YOLO，窄屏固定标识可见，切换会话继续保留模式", { timeout: 60_000 }, async t => {
  const app = await yoloWorkspace({ permissionMode: "yolo" });
  let server, browser;
  const variables = Object.fromEntries(["TMP", "TEMP", "TMPDIR"].map(key => [key, process.env[key]]));
  for (const key of Object.keys(variables)) process.env[key] = app.workspace;
  t.after(async () => {
    await browser?.close(); await server?.close(); await app.close();
    for (const [key, value] of Object.entries(variables)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const host = createMaybeCodeWebHost(app);
  server = await startMaybeCodeWebServer(host, { token: randomBytes(32).toString("hex"), port: 0, browserLogin: true });
  browser = await chromium.launch({ headless: true, artifactsDir: app.workspace, downloadsPath: app.workspace });
  const page = await browser.newPage();
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(server.createLoginUrl());
  const badge = page.locator(".status-badge");
  await badge.waitFor();
  assert.equal(await badge.textContent(), "YOLO · Auto-approve");
  assert.equal(await page.getByRole("combobox", { name: "Permissions", exact: true }).inputValue(), "yolo");
  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 720 });
    const box = await badge.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height < 720);
  }
  const original = app.sessionId;
  await app.renameSession(original, "Original YOLO session");
  await app.newSession();
  await page.waitForFunction(() => document.querySelectorAll(".resource-item").length === 2);
  assert.notEqual(app.sessionId, original); assert.equal(app.permissionMode, "yolo");
  await page.getByRole("combobox", { name: "Permissions", exact: true }).selectOption("default");
  await page.waitForFunction(() => document.querySelectorAll(".status-badge").length === 0);
  assert.equal(app.permissionMode, "default");
  await app.setPermissionMode("yolo");
  await badge.waitFor();
  await app.resumeSession(original);
  await page.waitForFunction(() => document.querySelector(".current-title")?.textContent === "Original YOLO session");
  assert.equal(app.permissionMode, "yolo");
  assert.equal(await badge.textContent(), "YOLO · Auto-approve");
  await page.goto("about:blank");
  await page.goto(server.createLoginUrl()); await badge.waitFor();
  assert.equal(await badge.textContent(), "YOLO · Auto-approve");
  assert.deepEqual(errors, []);
});
