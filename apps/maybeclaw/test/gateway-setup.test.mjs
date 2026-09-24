import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "node:http";
import { loadMayConfig } from "@may/config";
import { inspectGatewaySetup, startGatewaySetup } from "../dist/gateway-setup.js";
import { AgentGateway } from "../dist/gateway.js";
import { gatewaySettings } from "../dist/gateway-settings.js";
import { startGatewayServer } from "../dist/gateway-server.js";

async function fixture(t, config) {
  const base = fileURLToPath(new URL("../../../.zcode/tmp/maybeclaw-setup-tests/", import.meta.url));
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "case-")), path = join(directory, "config.json");
  if (config) await writeFile(path, JSON.stringify(config));
  let setup, server, gateway;
  t.after(async () => {
    await setup?.close(); await server?.close(); await gateway?.close();
    assert.ok(resolve(directory).startsWith(resolve(base) + sep)); await rm(directory, { recursive: true, force: true });
  });
  async function activate(listener) {
    const saved = await loadMayConfig({ path });
    gateway = new AgentGateway({ directory: join(directory, "state"), configPath: path, settings: gatewaySettings(saved) });
    server = await startGatewayServer({ gateway, server: listener });
  }
  setup = await startGatewaySetup({ path, port: 0, activate });
  const url = new URL(setup.url), token = new URLSearchParams(url.hash.slice(1)).get("initialize");
  const password = randomBytes(5).toString("hex");
  async function submit(data = { password, confirmation: password }, credential = token, extra = {}) {
    return fetch(`${url.origin}/api/setup`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${credential}`, ...extra }, body: JSON.stringify(data) });
  }
  return { setup, path, password, submit, origin: url.origin, activate };
}

test("首次设置直接保存密码哈希并在同一地址启用控制台", async t => {
  const { setup, path, password, submit, origin } = await fixture(t);
  await assert.rejects(access(path), { code: "ENOENT" });
  assert.equal((await submit(undefined, "invalid")).status, 403);
  assert.equal((await submit(undefined, undefined, { origin: "https://untrusted.example" })).status, 403);
  assert.equal((await submit({ password, confirmation: "different" })).status, 400);
  assert.equal((await submit({ password: password.slice(1), confirmation: password.slice(1) })).status, 400);
  await assert.rejects(access(path), { code: "ENOENT" });
  const initialized = await submit(); assert.equal(initialized.status, 200); await initialized.json(); await setup.completed;
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.apps.maybeclaw.version, 2); assert.deepEqual(saved.apps.maybeclaw.agents, []);
  assert.equal(saved.apps.maybeclaw.server.auth.password, undefined);
  assert.match(saved.apps.maybeclaw.server.auth.passwordHash, /^\$argon2id\$/);
  assert.equal((await inspectGatewaySetup(path)).needsSetup, false);
  await assert.rejects(access(setup.launchPath), { code: "ENOENT" });
  assert.equal((await submit()).status, 401);
  const login = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200); const { token } = await login.json();
  const sessions = await fetch(`${origin}/api/v2/sessions`, { headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual(await sessions.json(), []);
});

test("初始化保留其他配置并拒绝并发初始化", async t => {
  const config = { providers: {}, models: {}, apps: { other: { label: "保留" }, maybeclaw: { version: 2, agents: [{ id: "code", adapter: "may" }], server: { maxConcurrent: 2 } } } };
  const { setup, path, submit, activate } = await fixture(t, config);
  await assert.rejects(startGatewaySetup({ path, port: 0, activate }), { code: "EEXIST" });
  config.apps.other.label = "初始化期间保存";
  await writeFile(path, JSON.stringify(config));
  const response = await submit(); assert.equal(response.status, 200); await response.json(); await setup.completed;
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(saved.providers, config.providers); assert.deepEqual(saved.models, config.models);
  assert.deepEqual(saved.apps.other, config.apps.other); assert.deepEqual(saved.apps.maybeclaw.agents, config.apps.maybeclaw.agents);
  assert.equal(saved.apps.maybeclaw.server.maxConcurrent, 2);
  await assert.rejects(startGatewaySetup({ path, port: 0, activate }), /已经配置/);
});

test("外部设置认证后拒绝覆盖，取消初始化清理入口", async t => {
  const { setup, path, submit, password } = await fixture(t);
  const original = JSON.stringify({ providers: {}, apps: { maybeclaw: { version: 2, server: { auth: { password } } } } });
  await writeFile(path, original);
  assert.equal((await submit()).status, 409);
  assert.equal(await readFile(path, "utf8"), original);
  await setup.close();
  await assert.rejects(access(setup.launchPath), { code: "ENOENT" });
  await assert.rejects(access(`${path}.initialize.lock`), { code: "ENOENT" });
});

test("旧配置和损坏配置明确拒绝初始化", async t => {
  const { setup, path } = await fixture(t);
  await setup.close();
  for (const config of [{ providers: {}, apps: { maybeclaw: { runBudget: { maxSteps: 3 } } } }, { providers: {}, apps: { maybeclaw: { version: 1 } } }]) {
    const original = JSON.stringify(config); await writeFile(path, original);
    await assert.rejects(inspectGatewaySetup(path), /迁移/); assert.equal(await readFile(path, "utf8"), original);
  }
  await writeFile(path, "{"); await assert.rejects(inspectGatewaySetup(path), /有效的 JSON/);
});

test("初始化端口占用时释放配置锁和初始化文件", async t => {
  const { setup, path, activate } = await fixture(t);
  await setup.close();
  const occupied = createServer();
  await new Promise(resolve => occupied.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => occupied.close(error => error ? reject(error) : resolve())));
  await assert.rejects(startGatewaySetup({ path, port: occupied.address().port, activate }), { code: "EADDRINUSE" });
  await assert.rejects(access(`${path}.initialize.lock`), { code: "ENOENT" });
  await assert.rejects(access(path), { code: "ENOENT" });
});
