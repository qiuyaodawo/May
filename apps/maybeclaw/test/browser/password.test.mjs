import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright";
import { AgentGateway } from "../../dist/gateway.js";
import { gatewaySettings } from "../../dist/gateway-settings.js";
import { startGatewayServer } from "../../dist/gateway-server.js";

test("browser password login, session creation, password rotation, and logout", { timeout: 30_000 }, async t => {
  const base = fileURLToPath(new URL("../../../../.zcode/tmp/maybeclaw-browser-tests/", import.meta.url));
  await mkdir(base, { recursive: true }); const directory = await mkdtemp(join(base, "case-"));
  const path = join(directory, "config.json"), password = `  ${randomBytes(32).toString("base64url")}  `;
  const config = { apps: { maybeclaw: { version: 2, agents: [{ id: "code", adapter: "may" }], server: { auth: { password } } } } };
  await writeFile(path, JSON.stringify(config));
  const gateway = new AgentGateway({ directory, configPath: path, settings: gatewaySettings(config) });
  let browser, server;
  t.after(async () => {
    await browser?.close(); if (server) await server.close(); else await gateway.close();
    assert.ok(resolve(directory).startsWith(resolve(base) + sep)); await rm(directory, { recursive: true, force: true });
  });
  server = await startGatewayServer({ gateway, port: 0 });
  browser = await chromium.launch({ headless: true, env: { ...process.env, TEMP: directory, TMP: directory, TMPDIR: directory } });
  const page = await browser.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(server.url);
  async function login(value) {
    await page.locator(".connection-button").click();
    await page.getByLabel("管理员密码", { exact: true }).fill(value);
    await page.getByRole("button", { name: "连接", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".new-button").disabled);
  }
  await login(password);
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  const create = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "创建会话", exact: true }) });
  await create.getByLabel("会话名称", { exact: true }).fill("密码登录创建");
  await create.getByRole("group", { name: "默认 Agent（至少一个）" }).getByRole("checkbox").check();
  await create.getByRole("button", { name: "创建会话", exact: true }).click();
  await create.waitFor({ state: "detached" });
  assert.equal(gateway.sessions({ kind: "operator", id: "test" })[0].name, "密码登录创建");
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
  await page.reload(); await page.waitForFunction(() => document.querySelector(".new-button")?.disabled);
  await login(password);
  const saved = JSON.parse(await readFile(path, "utf8")), nextPassword = randomBytes(32).toString("base64url");
  assert.equal(saved.apps.maybeclaw.server.auth.password, undefined);
  saved.apps.maybeclaw.server.auth.password = nextPassword;
  await writeFile(path, JSON.stringify(saved));
  await page.waitForFunction(() => document.querySelector(".new-button").disabled);
  await login(nextPassword);
  await page.locator(".connection-button").click();
  await page.getByRole("button", { name: "断开连接", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".new-button").disabled);
  assert.deepEqual(errors, []);
});
