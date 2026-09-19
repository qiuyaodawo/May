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

test("资源新增、删除和重命名同步到已加载页面及搜索结果", { timeout: 120_000 }, async t => {
  const base = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../review/web-ui-browser");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "resources-"));
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
  // 仅操作会话目录；使用真实 Provider adapter，测试期间没有模型请求。
  const definition = defineAgent({
    model: new OpenAIResponsesModel({ apiKey: randomBytes(32).toString("hex"), model: "gpt-4.1", baseURL: "http://127.0.0.1:1/v1" }),
    permissionPolicy: () => "deny", sessionHistory: false, providerNativeAutoCompaction: false, autoCompactionStrategies: [],
  });
  app = await AgentWorkspace.open({
    workspace: directory, store, catalog,
    openApplication: selection => definition.open({ ...selection, store }),
  });
  for (let index = 0; index < 520; index++) {
    if (index > 0) await app.newSession();
    await app.renameSession(app.sessionId, `Entry ${String(index).padStart(4, "0")}`);
  }
  const sessions = await app.listSessions();
  const initialId = app.sessionId;
  const oldestId = sessions.find(session => session.title === "Entry 0000").id;
  const host = new ApplicationUiHost(app, {
    product: { id: "resource-test", title: "Resource test", subtitle: "", resourceKind: "session", suggestions: [] },
  });
  server = await startUiServer({ host, assets: await webUiAssets("Resource test", "session", { browserLogin: true }), token: randomBytes(32).toString("hex"), browserLogin: true, port: 0, close: () => host.close() });
  browser = await chromium.launch({ headless: true, artifactsDir: directory, downloadsPath: directory });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  let resourceRequests = 0;
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/ui/resources") resourceRequests++; });
  await page.goto(server.createLoginUrl());
  await loaded(page, 50, 520);
  const initialRequests = resourceRequests;
  for (let index = 0; index < 2; index++) await page.waitForResponse(response => new URL(response.url()).pathname === "/api/ui/snapshot");
  assert.equal(resourceRequests, initialRequests);

  const more = page.getByRole("button", { name: "加载更多记录", exact: true });
  for (let count = 100; count <= 550; count += 50) {
    await more.click();
    await loaded(page, Math.min(count, 520), 520);
  }
  assert.equal(await page.locator(".resource-item").count(), 520);

  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  await loaded(page, 521, 521);
  await page.locator('.resource-item[title="Entry 0519"]').click();
  await page.waitForFunction(() => document.querySelector(".current-title")?.textContent === "Entry 0519");
  assert.equal(await page.locator('.resource-item[title="新会话"]').count(), 1);

  const beforeRemoval = await host.snapshot(initialId);
  assert.equal(beforeRemoval.resources.some(resource => resource.id === oldestId), false);
  assert.equal(await app.deleteSession(oldestId), true);
  const afterRemoval = await host.snapshot(initialId);
  assert.notEqual(afterRemoval.resourcesVersion, beforeRemoval.resourcesVersion);
  await loaded(page, 520, 520);
  assert.equal(await page.locator('.resource-item[title="Entry 0000"]').count(), 0);

  const search = page.getByRole("searchbox", { name: "搜索会话或任务" });
  await search.fill("Entry");
  await loaded(page, 50, 519);
  await more.click();
  await loaded(page, 100, 519);
  const renamedId = sessions.find(session => session.title === "Entry 0001").id;
  await app.renameSession(renamedId, "Updated title");
  await loaded(page, 100, 518);
  await app.newSession();
  await app.renameSession(app.sessionId, "Entry added externally");
  await loaded(page, 100, 519);
  assert.equal(await search.inputValue(), "Entry");
  assert.equal(await page.locator('.resource-item[title="Entry added externally"]').count(), 1);
  assert.equal(await page.locator(".resource-item").count(), 100);

  await search.fill("Updated");
  await loaded(page, 1, 1);
  assert.equal(await page.locator('.resource-item[title="Updated title"]').count(), 1);
  const pendingSearch = page.waitForRequest(request => new URL(request.url()).pathname === "/api/ui/resources" && new URL(request.url()).searchParams.get("query") === "Entry");
  await search.fill("Entry");
  await pendingSearch;
  await search.fill("Updated");
  await loaded(page, 1, 1);
  assert.equal(await page.locator(".resource-item").count(), 1);
  assert.equal(await search.inputValue(), "Updated");

  await search.fill("");
  await loaded(page, 50, 521);
  const first = await host.resources({});
  const anchor = first.items.at(-1).id;
  assert.equal(await app.deleteSession(anchor), true);
  await assert.rejects(host.resources({ cursor: first.nextCursor }), error => error.status === 409);
  await loaded(page, 50, 520);
  await more.click();
  await loaded(page, 100, 520);
  const titles = await page.locator(".resource-item").evaluateAll(items => items.map(item => item.title));
  assert.equal(new Set(titles).size, titles.length);
  assert.deepEqual(errors, []);
});

async function loaded(page, count, total) {
  await page.waitForFunction(expected => document.querySelector(".sidebar > .list-empty")?.textContent === expected, `已加载 ${count} / ${total} 条`);
}
