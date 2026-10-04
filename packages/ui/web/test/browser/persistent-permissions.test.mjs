import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AgentWorkspace, defineAgent } from "@may/application";
import { OpenAIResponsesModel } from "@may/provider-openai";
import { InMemorySessionStore } from "@may/session";
import { InMemorySessionCatalog } from "@may/session/catalog";
import { ApplicationUiHost } from "@may/ui-client/application";
import { startUiServer } from "@may/ui-client/server";
import { FilePermissionRuleStore } from "../../../../permissions/dist/file-store.js";
import { chromium } from "playwright";
import { webUiAssets } from "../../dist/assets.js";

test("持久规则入口在真实 WebUI 中提供查询、创建和撤销操作", { timeout: 30_000 }, async t => {
  const base = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../plugin-verification/persistent-browser");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "run-"));
  let app, rules, server, browser;
  const temporaryVariables = Object.fromEntries(["TMP", "TEMP", "TMPDIR"].map(key => [key, process.env[key]]));
  for (const key of Object.keys(temporaryVariables)) process.env[key] = directory;
  t.after(async () => {
    await browser?.close(); await server?.close(); await app?.close(); await rules?.close();
    for (const [key, value] of Object.entries(temporaryVariables)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory, { recursive: true, force: true });
  });
  const scopeId = "project:may:agent:writer", description = "Modify Markdown files under project docs";
  rules = await FilePermissionRuleStore.open({ path: join(directory, "permission-rules.json") });
  const store = new InMemorySessionStore();
  const definition = defineAgent({ model: new OpenAIResponsesModel({ apiKey: randomBytes(32).toString("hex"), model: "gpt-4.1", baseURL: "http://127.0.0.1:1/v1" }),
    permissionRuleStore: rules, permissionPolicy: () => ({ decision: "ask", grantKey: "docs-markdown", persistent: { scopeId, description } }),
    sessionHistory: false, providerNativeAutoCompaction: false, autoCompactionStrategies: [],
  });
  app = await AgentWorkspace.open({ workspace: directory, store, catalog: new InMemorySessionCatalog(), openApplication: selection => definition.open({ ...selection, store }) });
  await app.createPermissionRule({ tool: { name: "write", description: "Write Markdown", inputSchema: { type: "object" }, permissionVersion: "1" }, input: { path: "docs/guide.md" },
    context: { runId: "management", step: 1, toolCallId: "call", idempotencyKey: "call", signal: new AbortController().signal, report() {} },
  }, { decision: "allow", createdBy: "browser-operator" });
  let available = true;
  const host = new ApplicationUiHost(app, {
    product: { id: "persistent-browser", title: "Permission rules", subtitle: "", resourceKind: "session", suggestions: [] },
    panels: async () => [{ id: "product-details", title: "Product details", fields: [{ label: "Owner", value: "browser-operator" }] }],
    available: name => name !== "permission.rules.list" || available,
    permissionActor: () => "browser-operator",
    permissionRules: { list: () => app.listPermissionRules(scopeId), revoke: id => app.revokePermissionRule(id), create: (sourceId, decision) => app.createPermissionRuleFrom(sourceId, { decision, createdBy: "browser-operator" }) },
  });
  server = await startUiServer({ host, assets: await webUiAssets("Permission rules", "session", { browserLogin: true }), token: randomBytes(32).toString("hex"), browserLogin: true, port: 0, close: () => host.close() });
  browser = await chromium.launch({ headless: true, artifactsDir: directory, downloadsPath: directory });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(server.createLoginUrl());
  await page.getByRole("button", { name: "显示或隐藏详情", exact: true }).click();
  await page.getByRole("heading", { name: "Product details", exact: true }).waitFor();
  const manage = page.getByRole("button", { name: "查看和管理规则", exact: true });
  async function showRules(expected) {
    await manage.click();
    await page.waitForFunction(({ expected, description }) => [...document.querySelectorAll(".command-output button")].filter(button => button.textContent === `撤销 ${description}`).length === expected, { expected, description });
  }
  await showRules(1);
  await page.locator(".command-output").getByRole("heading", { name: "持久权限规则", exact: true }).waitFor();
  assert.match(await page.locator(".command-output").innerText(), /browser-operator/u);
  assert.match(await page.locator(".command-output").innerText(), /Modify Markdown files under project docs/u);

  for (const [index, decision] of ["禁止", "允许"].entries()) {
    await page.getByRole("button", { name: `按此范围创建${decision}规则`, exact: true }).first().click();
    const dialog = page.locator("dialog[open]");
    assert.match(await dialog.innerText(), /project:may:agent:writer/u);
    assert.match(await dialog.innerText(), /禁止规则优先于允许规则/u);
    await dialog.getByRole("button", { name: "确认", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await showRules(index + 2);
  }
  const saved = await rules.list(scopeId);
  assert.equal(saved.length, 3);
  assert.deepEqual(saved.map(rule => rule.decision), ["allow", "deny", "allow"]);
  assert.equal(saved.every(rule => rule.createdBy === "browser-operator"), true);
  assert.equal(saved.every(rule => rule.scopeId === scopeId), true);

  for (let remaining = 2; remaining >= 0; remaining--) {
    await page.getByRole("button", { name: `撤销 ${description}`, exact: true }).first().click();
    const dialog = page.locator("dialog[open]");
    await dialog.getByRole("button", { name: "确认", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal((await rules.list(scopeId)).length, remaining);
    await showRules(remaining);
  }
  await page.locator(".command-output").getByText("当前没有持久权限规则。", { exact: true }).waitFor();
  available = false; host.changed();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].find(button => button.textContent === "查看和管理规则")?.disabled);
  assert.deepEqual(errors, []);
});
