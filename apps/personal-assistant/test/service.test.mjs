import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { assistantSettings } from "../dist/settings.js";
import { createAssistantContext, closeAssistantContext } from "../dist/context.js";
import { PersonalAssistant } from "../dist/service.js";

const roots = [];

function completed(text, toolCalls) {
  return {
    type: "response.completed",
    message: {
      role: "assistant",
      content: text === undefined ? [] : [{ type: "text", text }],
      ...(toolCalls === undefined ? {} : { toolCalls }),
    },
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  };
}

/** 离线固定模型：按提示词返回固定的工具调用，不请求任何外部服务。 */
function scriptedModel() {
  return {
    async *stream(request) {
      const last = request.messages.at(-1);
      const prompt = last?.role === "user"
        ? last.content.filter((part) => part.type === "text").map((part) => part.text).join("")
        : "";
      if (prompt.includes("记录一条资料")) {
        yield completed("准备写入个人数据库。", [{
          id: "call-write",
          name: "vault_write",
          input: { path: "notes/one.md", content: "---\ntitle: 第一条\n---\n\n会议在周五下午。\n" },
        }]);
        return;
      }
      if (prompt.includes("删除那条资料")) {
        yield completed("准备删除文件，需要你确认。", [{
          id: "call-remove",
          name: "vault_remove",
          input: { path: "notes/one.md" },
        }]);
        return;
      }
      yield completed(last?.role === "tool" ? "工具已经执行完毕。" : "收到。");
    },
  };
}

let assistant;
let context;
let server;
let token;
let hostId;
const config = {
  path: "/tmp/personal-assistant-test.json",
  providers: {},
  models: {},
  apps: { "personal-assistant": {} },
};

before(async () => {
  const root = await mkdtemp(join(tmpdir(), "may-assistant-service-"));
  roots.push(root);
  const settings = assistantSettings(config, {}, { home: root, port: 0 });
  context = await createAssistantContext({ settings });
  assistant = await PersonalAssistant.open({ settings, model: scriptedModel(), context, poll: false });
  const served = await assistant.serve();
  token = served.token;
  server = served.url;
});

after(async () => {
  await assistant?.close();
  if (context !== undefined) await closeAssistantContext(context).catch(() => undefined);
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function api(path, options = {}) {
  const response = await fetch(`${server}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
  });
  const text = await response.text();
  return { status: response.status, text, json: text === "" ? undefined : JSON.parse(text) };
}

async function snapshot() {
  return (await api("/api/ui/snapshot")).json;
}

async function command(name, args = {}, requestId = `r-${Math.random().toString(36).slice(2)}`) {
  const current = await snapshot();
  return api("/api/ui/commands", {
    method: "POST",
    body: JSON.stringify({ version: 1, hostId: current.hostId, requestId, name, targetId: current.selectedId, args }),
  });
}

async function waitFor(check, description, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待超时：${description}`);
}

test("没有令牌的请求被拒绝", async () => {
  const response = await fetch(`${server}/api/ui/snapshot`);
  assert.equal(response.status, 401);
});

test("工作台页面可以直接打开，并提供助手面板模块", async () => {
  const page = await fetch(`${server}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /个人助手/);
  const script = await (await fetch(`${server}/app.js`)).text();
  assert.match(script, /\/assistant-panel\.js/);
  assert.match(script, /\/ui\/client\.js/);
  const panel = await (await fetch(`${server}/assistant-panel.js`));
  assert.equal(panel.status, 200);
  assert.match(await panel.text(), /createAssistantPanel/);
});

test("快照包含产品信息、会话与助手状态面板", async () => {
  const state = await snapshot();
  hostId = state.hostId;
  assert.equal(state.version, 1);
  assert.equal(state.product.id, "personal-assistant");
  assert.equal(state.product.resourceKind, "session");
  assert.equal(state.selectedId, assistant.sessionId);
  assert.ok(state.commands.includes("message.submit"));
  assert.ok(state.commands.includes("draft.confirm"));
  const panel = state.panels.find((item) => item.id === "assistant");
  assert.ok(panel);
  assert.ok(panel.fields.some((field) => field.label === "个人数据库"));
});

test("提交任务后工具真的写入个人数据库", async () => {
  const submitted = await command("message.submit", { text: "记录一条资料" }, "submit-write");
  assert.equal(submitted.status, 200);
  const content = await waitFor(async () => {
    const text = await readFile(join(context.vault.root, "notes/one.md"), "utf8").catch(() => undefined);
    return text === undefined ? false : text;
  }, "文件写入完成");
  assert.match(content, /会议在周五下午/);
  await waitFor(async () => !(await snapshot()).blocks.some((block) => block.status === "running" || block.status === "streaming"), "运行结束");
  assert.equal(assistant.isRunning, false);
});

test("删除文件需要用户在网页上确认", async () => {
  await command("message.submit", { text: "删除那条资料" }, "submit-remove");
  const pending = await waitFor(async () => {
    const state = await snapshot();
    const request = state.interactions.find((item) => item.toolName === "vault_remove");
    return request === undefined ? undefined : { request, hostId: state.hostId };
  }, "删除审批");
  assert.match(pending.request.detail, /notes\/one\.md/u);

  const denied = await command("approval.resolve", { id: pending.request.id, decision: "deny" }, "deny-remove");
  assert.equal(denied.status, 200);
  assert.equal((await readFile(join(context.vault.root, "notes/one.md"), "utf8")).includes("会议在周五下午"), true);

  await command("message.submit", { text: "删除那条资料" }, "submit-remove-2");
  const again = await waitFor(async () => {
    const state = await snapshot();
    const request = state.interactions.find((item) => item.toolName === "vault_remove");
    return request === undefined ? undefined : { request, hostId: state.hostId };
  }, "第二次删除审批");
  const allowed = await command("approval.resolve", { id: again.request.id, decision: "allow" }, "allow-remove");
  assert.equal(allowed.status, 200);
  await waitFor(async () => {
    try {
      await readFile(join(context.vault.root, "notes/one.md"), "utf8");
      return false;
    } catch {
      return true;
    }
  }, "文件被删除");
});

test("手机可以查看、修改并确认邮件草稿", async () => {
  const view = await context.mailbox.createDraft({
    to: ["teacher@example.edu.cn"],
    subject: "关于报名",
    body: "第一版",
  });
  const listed = await command("draft.list", {}, "draft-list");
  const drafts = JSON.parse(listed.json.output.text).data.drafts;
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].confirmed, false);

  const updated = await command("draft.update", { id: view.record.id, body: "第二版" }, "draft-update");
  assert.equal(updated.status, 200);
  assert.match(JSON.parse(updated.json.output.text).message, /重新确认/);

  const confirmed = await command("draft.confirm", { id: view.record.id }, "draft-confirm");
  assert.match(JSON.parse(confirmed.json.output.text).message, /已确认/);
  const reread = await context.mailbox.readDraft(view.record.id);
  assert.equal(reread.content.body, "第二版");
  assert.equal(reread.confirmed, true);
});

test("网页不提供直接发送邮件的入口", async () => {
  const state = await snapshot();
  assert.equal(state.commands.includes("mail.send"), false);
  const response = await command("mail.send", { id: "dx" }, "mail-send");
  assert.equal(response.status, 409);
  assert.match(response.json.error, /当前状态不允许/);
});

test("未实现的命令被拒绝，重复的请求编号不会重复执行", async () => {
  const unknown = await command("does.not.exist", {}, "unknown-command");
  assert.equal(unknown.status, 409);
  const first = await command("vault.reindex", {}, "reindex-once");
  assert.equal(first.status, 200);
  const repeated = await command("vault.reindex", {}, "reindex-once");
  assert.equal(repeated.status, 200);
  assert.deepEqual(repeated.json, first.json);
  const conflicting = await command("vault.reindex", { path: "other" }, "reindex-once");
  assert.equal(conflicting.status, 409);
});

test("未打开办事页面时，网页不展示表单", async () => {
  const response = await command("ehall.review", {}, "ehall-review-empty");
  assert.equal(response.status, 409);
  assert.match(response.json.error, /还没有打开任何办事页面/);
});

test("没有配置邮箱时，checkMail 直接报错，定时检查保持安静", async () => {
  await assert.rejects(() => assistant.checkMail(), /没有配置邮箱/);
  await assistant.pollNow();
  assert.equal(assistant.isRunning, false);
});

test("邮箱不可用时定时检查不会拖垮服务", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "may-assistant-poll-"));
  roots.push(root);
  const settings = assistantSettings({
    path: join(root, "config.json"),
    providers: {},
    models: {},
    apps: {
      "personal-assistant": {
        mail: { host: "127.0.0.1", port: 1, secure: false, user: "me@example.com", address: "me@example.com" },
        poll: { enabled: false },
      },
    },
  }, { MAY_ASSISTANT_MAIL_PASSWORD: "unused" }, { home: root });
  const pollContext = await createAssistantContext({ settings });
  const poller = await PersonalAssistant.open({
    settings,
    model: scriptedModel(),
    context: pollContext,
    poll: false,
  });
  try {
    assert.equal(pollContext.mailAvailable, true);
    await assert.rejects(() => poller.checkMail());
    await poller.pollNow();
    assert.equal(poller.isRunning, false);
    assert.equal(pollContext.mailbox.ledger().pending().unhandledMail, 0);
  } finally {
    await poller.close();
    await closeAssistantContext(pollContext);
  }
});

test("关闭服务之后不再接受请求", async () => {
  await assistant.close();
  await assert.rejects(() => fetch(`${server}/api/ui/snapshot`, {
    headers: { authorization: `Bearer ${token}` },
  }));
});
