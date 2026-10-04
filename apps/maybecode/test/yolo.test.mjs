import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { PassThrough } from "node:stream";
import { createNodeTerminal } from "@may/tui/node-terminal";
import { createWriteTool, createShellTool } from "@may/coding-tools";
import { PermissionToolExecutor } from "@may/permissions";
import { InMemorySessionStore } from "@may/session";
import { InMemorySessionCatalog, createCodingPermissionPolicy, parseMaybeCodeArgs, executeMaybeCodeSlashCommand,
  openConfiguredMaybeCode, MaybeCodePrototypeView, TranscriptStore } from "../dist/index.js";
import { yoloDirectory, yoloWorkspace } from "./yolo-support.mjs";

function context(signal = new AbortController().signal) {
  return { runId: "permissions", step: 1, toolCallId: "write", idempotencyKey: "permissions:1:write", signal,
    report(update) { assert.ok(["output.delta", "progress"].includes(update.type)); } };
}

test("classic 终端更新提示时保留输入文字和光标位置", async t => {
  const input = new PassThrough(), output = new PassThrough();
  Object.assign(output, { isTTY: true, columns: 80 });
  let rendered = "";
  output.on("data", chunk => { rendered += chunk.toString(); });
  const terminal = createNodeTerminal({ input, output });
  t.after(() => { terminal.close(); input.destroy(); output.destroy(); });
  const answer = terminal.question("> ");
  input.write("abcd\x1b[D\x1b[D");
  await new Promise(resolve => setImmediate(resolve));
  terminal.updatePrompt("YOLO · Auto-approve > ");
  terminal.write("YOLO enabled\n");
  assert.match(stripVTControlCharacters(rendered), /YOLO · Auto-approve > abcd/);
  input.write("X\r");
  assert.equal(await answer, "abXcd");
});

test("YOLO 参数提供明确的开启、关闭和冲突检查", () => {
  assert.equal(parseMaybeCodeArgs([]).permissionMode, undefined);
  assert.equal(parseMaybeCodeArgs(["--yolo"]).permissionMode, "yolo");
  assert.equal(parseMaybeCodeArgs(["--no-yolo", "--ui", "web"]).permissionMode, "default");
  for (const args of [["--yolo", "--no-yolo"], ["--yolo", "--yolo"], ["--no-yolo", "--no-yolo"]]) {
    assert.throws(() => parseMaybeCodeArgs(args), /Specify only one/);
  }
});

test("真实工具在默认模式等待审批，在 YOLO 中自动执行并保留禁止、取消和路径检查", async t => {
  const workspace = await yoloDirectory();
  const tool = createWriteTool({ cwd: workspace });
  const input = tool.parse({ path: "approved.txt", content: "approved" });
  let mode = "default";
  const permissions = new PermissionToolExecutor({ policy: createCodingPermissionPolicy({ mode: () => mode }) });
  t.after(() => permissions.close());
  const events = permissions.events[Symbol.asyncIterator]();
  const pending = permissions.execute({ tool, input, context: context() });
  const request = (await events.next()).value;
  assert.equal(request.type, "approval.requested");
  await assert.rejects(access(join(workspace, input.path)), { code: "ENOENT" });
  await permissions.resolve(request.request.id, "allow"); await pending;
  assert.equal(await readFile(join(workspace, input.path), "utf8"), "approved");
  mode = "yolo";
  await permissions.execute({ tool, input: tool.parse({ path: "automatic.txt", content: "automatic" }), context: context() });
  assert.equal(await readFile(join(workspace, "automatic.txt"), "utf8"), "automatic");
  const shell = createShellTool({ cwd: workspace });
  const command = process.platform === "win32" ? "Write-Output 'yolo-shell'" : "printf 'yolo-shell'";
  const result = await permissions.execute({ tool: shell, input: shell.parse({ command }), context: context() });
  assert.equal(result.exitCode, 0); assert.match(result.stdout, /yolo-shell/);
  await assert.rejects(permissions.execute({ tool, input: tool.parse({ path: "../outside.txt", content: "denied" }), context: context() }));
  await assert.rejects(permissions.execute({ tool, input, context: context(AbortSignal.abort("cancelled")) }));
  const denied = new PermissionToolExecutor({ policy: createCodingPermissionPolicy({ mode: () => "yolo", policy: () => "deny" }) });
  t.after(() => denied.close());
  await assert.rejects(denied.execute({ tool, input: { path: "denied.txt", content: "denied" }, context: context() }), /denied/i);
  await assert.rejects(access(join(workspace, "denied.txt")), { code: "ENOENT" });
});

test("YOLO workspace 状态用于命令和固定状态栏，会话切换后保持，恢复历史不自动启用", async t => {
  const store = new InMemorySessionStore(), catalog = new InMemorySessionCatalog();
  const app = await yoloWorkspace({ store, catalog }); t.after(() => app.close());
  assert.equal(app.permissionMode, "default");
  const view = new MaybeCodePrototypeView({ store: new TranscriptStore(), workspace: app.workspace,
    permissionMode: () => app.permissionMode, onSubmit: () => {} });
  t.after(() => view.dispose());
  const render = width => view.render({ width, height: 24 }).lines.map(stripVTControlCharacters).join("\n");
  assert.doesNotMatch(render(100), /YOLO/);
  assert.equal((await executeMaybeCodeSlashCommand("/yolo status", app)).text, "YOLO disabled");
  assert.equal(app.permissionMode, "default");
  assert.equal((await executeMaybeCodeSlashCommand("/yolo", app)).text, "YOLO enabled");
  assert.equal(app.permissionMode, "yolo");
  assert.equal((await executeMaybeCodeSlashCommand("/yolo", app)).text, "YOLO enabled");
  assert.equal(app.permissionMode, "yolo");
  assert.equal((await executeMaybeCodeSlashCommand("/yolo on", app)).text, "YOLO enabled");
  for (const width of [25, 80, 120]) {
    view.setStatus("Running a long operation");
    assert.match(render(width), /YOLO · Auto-approve/);
  }
  const original = app.sessionId;
  await app.newSession(); assert.equal(app.permissionMode, "yolo");
  await app.resumeSession(original); assert.equal(app.permissionMode, "yolo");
  assert.equal((await executeMaybeCodeSlashCommand("/yolo status", app)).text, "YOLO enabled");
  assert.equal((await executeMaybeCodeSlashCommand("/yolo invalid", app)).type, "usage");
  assert.equal(app.permissionMode, "yolo");
  await app.close();
  const resumed = await yoloWorkspace({ workspace: app.workspace, store, catalog, sessionId: original });
  t.after(() => resumed.close());
  assert.equal(resumed.permissionMode, "default");
  await resumed.setPermissionMode("yolo");
  assert.equal((await executeMaybeCodeSlashCommand("/yolo off", resumed)).text, "YOLO disabled");
  assert.equal((await executeMaybeCodeSlashCommand("/yolo", resumed)).text, "YOLO enabled");
  assert.equal(resumed.permissionMode, "yolo");
  await assert.rejects(resumed.setPermissionMode("invalid"), /permissionMode/);
});

test("真实配置文件与启动选项确定 YOLO，运行时切换不写入配置", async t => {
  const workspace = await yoloDirectory(), configPath = join(workspace, "may.json");
  const configuration = JSON.stringify({ providers: { local: { adapter: "openai-responses", apiKey: "unused-without-model-requests", baseURL: "http://127.0.0.1:1/v1" } },
    defaultModel: "offline", models: { offline: { provider: "local", model: "gpt-4.1" }, second: { provider: "local", model: "gpt-4.1-mini" } }, apps: { maybecode: { permissionMode: "yolo" } } });
  await writeFile(configPath, configuration);
  const options = { workspace, configPath, dataDirectory: join(workspace, "data"), skills: false, mcp: false, observability: false, instructions: "Local configuration tests" };
  const app = await openConfiguredMaybeCode({ ...options, git: false }); t.after(() => app.close());
  assert.equal(app.permissionMode, "yolo");
  await Promise.all([app.switchModel("second"), app.setPermissionMode("default")]);
  assert.equal(app.modelInfo.profile, "second"); assert.equal(app.permissionMode, "default");
  assert.equal(await readFile(configPath, "utf8"), configuration); await app.close();
  const overridden = await openConfiguredMaybeCode({ ...options, git: false, permissionMode: "default" });
  t.after(() => overridden.close()); assert.equal(overridden.permissionMode, "default"); await overridden.close();
  await writeFile(configPath, configuration.replace('"permissionMode":"yolo"', '"permissionMode":"invalid"'));
  await assert.rejects(openConfiguredMaybeCode({ ...options, git: false }), /permissionMode/);
});
