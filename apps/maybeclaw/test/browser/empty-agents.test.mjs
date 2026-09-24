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

test("browser empty agent list startup, login, adding first agent, persistent config, session creation without restart, and deletion protection", { timeout: 35_000 }, async t => {
  const base = fileURLToPath(new URL("../../../../.zcode/tmp/maybeclaw-browser-tests/", import.meta.url));
  await mkdir(base, { recursive: true }); const directory = await mkdtemp(join(base, "case-"));
  const path = join(directory, "config.json"), password = `  ${randomBytes(32).toString("base64url")}  `;
  const config = { apps: { maybeclaw: { version: 2, agents: [], server: { auth: { password } } } } };
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

  const adapterPath = fileURLToPath(new URL("../../dist/gateway-rpc-adapter.js", import.meta.url));
  const options = { transport: "stdio", command: process.execPath, args: [fileURLToPath(new URL("../../examples/rpc-file-agent.mjs", import.meta.url)), "--directory", join(directory, "rpc-state"), "--workspace", directory] };

  await page.locator(".connection-button").click();
  await page.getByLabel("管理员密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".new-button").disabled);

  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  const emptyDialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "创建会话", exact: true }) });
  await emptyDialog.getByText("当前尚未配置 Agent。", { exact: false }).first().waitFor({ state: "visible" });
  await emptyDialog.getByLabel("会话名称", { exact: true }).fill("尝试无Agent会话");
  await emptyDialog.getByRole("button", { name: "创建会话", exact: true }).click();
  await emptyDialog.getByText("创建会话需要名称和至少一个默认 Agent。", { exact: false }).waitFor({ state: "visible" });
  assert.equal(gateway.sessions({ kind: "operator", id: "test" }).length, 0);
  await emptyDialog.getByRole("button", { name: "关闭", exact: true }).click();
  await emptyDialog.waitFor({ state: "detached" });

  await page.getByRole("button", { name: "Agent 管理", exact: true }).click();
  const agentsModal = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Agent 管理", exact: true }) });
  await agentsModal.getByText("尚未配置 Agent。", { exact: false }).waitFor({ state: "visible" });
  await agentsModal.getByRole("button", { name: "添加 Agent", exact: true }).click();

  const editorModal = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Agent 配置", exact: true }) });
  await editorModal.getByLabel("Agent ID", { exact: true }).fill("reviewer");
  await editorModal.getByLabel("显示名称", { exact: true }).fill("评审助手");
  await editorModal.getByLabel("适配器", { exact: true }).selectOption("module");
  await editorModal.getByLabel("外部适配器模块路径", { exact: true }).fill(adapterPath);
  await editorModal.getByLabel("适配器 options（JSON）", { exact: true }).fill(JSON.stringify(options));
  await editorModal.getByRole("button", { name: "保存配置", exact: true }).click();
  await editorModal.waitFor({ state: "detached" });

  const savedConfig = JSON.parse(await readFile(path, "utf8"));
  assert.equal(savedConfig.apps.maybeclaw.agents.length, 1);
  assert.equal(savedConfig.apps.maybeclaw.agents[0].id, "reviewer");
  assert.equal(savedConfig.apps.maybeclaw.agents[0].name, "评审助手");
  assert.equal(savedConfig.apps.maybeclaw.agents[0].adapter, "module");
  assert.equal(savedConfig.apps.maybeclaw.agents[0].module, adapterPath);
  assert.ok(savedConfig.apps.maybeclaw.server.auth.passwordHash);
  assert.equal(savedConfig.apps.maybeclaw.server.auth.password, undefined);

  const updatedAgentsModal = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Agent 管理", exact: true }) });
  await updatedAgentsModal.getByRole("button", { name: "关闭", exact: true }).click();
  await updatedAgentsModal.waitFor({ state: "detached" });

  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  const createDialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "创建会话", exact: true }) });
  await createDialog.getByLabel("会话名称", { exact: true }).fill("首个会话");
  const agentCheckbox = createDialog.getByRole("group", { name: "默认 Agent（至少一个）" }).getByRole("checkbox");
  await agentCheckbox.waitFor({ state: "visible" });
  await agentCheckbox.check();
  await createDialog.getByRole("button", { name: "创建会话", exact: true }).click();
  await createDialog.waitFor({ state: "detached" });

  const activeSessions = gateway.sessions({ kind: "operator", id: "test" });
  assert.equal(activeSessions.length, 1);
  assert.equal(activeSessions[0].name, "首个会话");
  assert.deepEqual(activeSessions[0].defaultAgents, ["reviewer"]);

  const session = activeSessions[0];
  await gateway.handle("/agent create reviewer", { kind: "operator", id: "test" }, { requestId: "req-create-1", sessionId: session.id });
  const binding = gateway.store.get("bindings", `${session.id}:reviewer`);
  assert.ok(binding);
  assert.equal(binding.status, "ready");

  await page.getByRole("button", { name: "Agent 管理", exact: true }).click();
  const agentsList = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Agent 管理", exact: true }) });
  await agentsList.getByRole("button", { name: "编辑", exact: true }).click();
  const editReviewer = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Agent 配置", exact: true }) });
  await editReviewer.getByRole("button", { name: "删除配置", exact: true }).click();
  const deleteConfirm = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "删除 Agent 配置", exact: true }) });
  await deleteConfirm.getByRole("button", { name: "确认删除", exact: true }).click();
  await deleteConfirm.getByText("操作失败。请检查宿主日志、配置或当前状态。", { exact: true }).waitFor({ state: "visible" });
  assert.equal(gateway.status().agents.length, 1);
  assert.ok(gateway.store.get("bindings", `${session.id}:reviewer`));
  await deleteConfirm.getByRole("button", { name: "关闭", exact: true }).click();
  await deleteConfirm.waitFor({ state: "detached" });
  await editReviewer.getByRole("button", { name: "关闭", exact: true }).click();
  await editReviewer.waitFor({ state: "detached" });
  await agentsList.getByRole("button", { name: "关闭", exact: true }).click();
  await agentsList.waitFor({ state: "detached" });

  await page.getByRole("button", { name: "会话管理", exact: true }).click();
  const sessionManager = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "会话管理 · 首个会话", exact: true }) });
  await sessionManager.getByRole("button", { name: "删除会话", exact: true }).click();
  const deleteSession = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "删除会话", exact: true }) });
  await deleteSession.getByRole("button", { name: "确认删除", exact: true }).click();
  await deleteSession.waitFor({ state: "detached" });
  assert.equal(gateway.sessions({ kind: "operator", id: "test" }).length, 0);
  assert.equal(gateway.store.get("bindings", `${session.id}:reviewer`), undefined);

  await page.getByRole("button", { name: "Agent 管理", exact: true }).click();
  const agentsListAfter = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Agent 管理", exact: true }) });
  await agentsListAfter.getByRole("button", { name: "编辑", exact: true }).click();
  const editReviewerAfter = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Agent 配置", exact: true }) });
  await editReviewerAfter.getByRole("button", { name: "删除配置", exact: true }).click();
  const deleteConfirmAfter = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "删除 Agent 配置", exact: true }) });
  await deleteConfirmAfter.getByRole("button", { name: "确认删除", exact: true }).click();
  await deleteConfirmAfter.waitFor({ state: "detached" });

  const configAfterDelete = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(configAfterDelete.apps.maybeclaw.agents, []);

  const refreshedAgentsList = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Agent 管理", exact: true }) });
  await refreshedAgentsList.getByText("尚未配置 Agent。", { exact: false }).waitFor({ state: "visible" });
  await refreshedAgentsList.getByRole("button", { name: "添加 Agent", exact: true }).click();
  const reAddModal = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Agent 配置", exact: true }) });
  await reAddModal.getByLabel("Agent ID", { exact: true }).fill("code");
  await reAddModal.getByLabel("显示名称", { exact: true }).fill("代码编写");
  await reAddModal.getByLabel("适配器", { exact: true }).selectOption("module");
  await reAddModal.getByLabel("外部适配器模块路径", { exact: true }).fill(adapterPath);
  await reAddModal.getByLabel("适配器 options（JSON）", { exact: true }).fill(JSON.stringify(options));
  await reAddModal.getByRole("button", { name: "保存配置", exact: true }).click();
  await reAddModal.waitFor({ state: "detached" });

  const finalConfig = JSON.parse(await readFile(path, "utf8"));
  assert.equal(finalConfig.apps.maybeclaw.agents.length, 1);
  assert.equal(finalConfig.apps.maybeclaw.agents[0].id, "code");

  const finalAgentsList = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Agent 管理", exact: true }) });
  await finalAgentsList.getByRole("button", { name: "关闭", exact: true }).click();
  await finalAgentsList.waitFor({ state: "detached" });

  assert.deepEqual(errors, []);
});
