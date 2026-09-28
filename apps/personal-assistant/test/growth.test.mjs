import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SkillRegistry } from "@may/skills";
import { RuleBook, learnSkill } from "../dist/growth/rule-book.js";
import { openAssistantApplication } from "../dist/agent.js";
import { createPermissionPolicy } from "../dist/permissions.js";
import { assistantSettings } from "../dist/settings.js";
import { createAssistantContext, closeAssistantContext } from "../dist/context.js";
import { Vault } from "../dist/vault/vault.js";

const roots = [];
async function createContext() {
  const root = await mkdtemp(join(tmpdir(), "may-assistant-growth-"));
  roots.push(root);
  const settings = assistantSettings({
    path: join(root, "config.json"),
    providers: {},
    models: {},
    apps: { "personal-assistant": {} },
  }, {}, { home: root });
  const context = await createAssistantContext({ settings });
  return { root, context };
}

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test("记录的规则会写进个人数据库并进入 Git", async () => {
  const { root, context } = await createContext();
  const record = await context.rules.learn({
    title: "截止时间不是开始时间",
    rule: "通知里的报名截止时间不是活动开始时间，两者要分别记录。",
    scope: "所有办事通知",
    tags: ["通知", "时间"],
  });
  assert.match(record.path, /^rules\/\d{4}-\d{2}-\d{2}-/u);
  const content = await readFile(join(root, "vault", record.path), "utf8");
  assert.match(content, /报名截止时间不是活动开始时间/u);
  assert.match(content, /适用范围：所有办事通知/u);
  const log = await context.vault.git.log(5);
  assert.equal(log[0]?.subject, "记录规则：截止时间不是开始时间");
  await closeAssistantContext(context);
});

test("规则会出现在新会话的系统提示中，换一次会话也有效", async () => {
  const { root, context } = await createContext();
  const rules = new RuleBook(context.vault);
  assert.equal(await rules.instructions(), "");

  await rules.learn({ title: "第一条规则", rule: "不要把报名截止时间当成活动开始时间。" });
  const instructions = await rules.instructions();
  assert.match(instructions, /## 用户纠正后的规则/);
  assert.match(instructions, /1\. \[全部任务\] 不要把报名截止时间当成活动开始时间。/u);

  await rules.learn({ title: "第二条规则", rule: "提交办事表单前必须先展示关键字段。", scope: "办事大厅" });
  const updated = await rules.instructions();
  assert.match(updated, /\[办事大厅\] 提交办事表单前必须先展示关键字段。/u);

  const settings = assistantSettings({
    path: join(root, "config.json"),
    providers: {},
    models: {},
    apps: { "personal-assistant": {} },
  }, {}, { home: root });
  const model = {
    requests: [],
    async *stream(request) {
      this.requests.push(request);
      yield { type: "response.completed", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } };
    },
  };
  const { InMemorySessionStore } = await import("@may/session");
  const store = new InMemorySessionStore();
  const application = await openAssistantApplication({ context, model, store }, { resume: false });
  await (await application.submit({ input: "这封通知的报名截止时间是哪天" })).result;
  const system = model.requests[0].messages.filter((message) => message.role === "system");
  const prompt = system.map((message) => message.content.map((part) => part.text ?? "").join("")).join("\n");
  assert.match(prompt, /不要把报名截止时间当成活动开始时间/u);
  assert.match(prompt, /\[办事大厅\] 提交办事表单前必须先展示关键字段。/u);
  await application.close();

  const second = await openAssistantApplication({ context, model, store }, { resume: false });
  await (await second.submit({ input: "再看一次" })).result;
  const again = model.requests[1].messages
    .filter((message) => message.role === "system")
    .map((message) => message.content.map((part) => part.text ?? "").join("")).join("\n");
  assert.match(again, /不要把报名截止时间当成活动开始时间/u);
  await second.close();
  await closeAssistantContext(context);
});

test("技能写入后可以被技能注册表发现", async () => {
  const { root, context } = await createContext();
  const result = await learnSkill(context.vault, {
    name: "notice-to-apply",
    description: "把办事通知变成待补材料、e hall 表单和邮件草稿。",
    body: "1. mail_check 找到新邮件\n2. mail_thread 了解往来\n3. ehall_prepare 检查材料",
  });
  assert.equal(result.path, "skills/notice-to-apply/SKILL.md");
  const registry = await SkillRegistry.discover([join(root, "vault", "skills")]);
  assert.equal(registry.list().length, 1);
  const document = await registry.load("notice-to-apply");
  assert.match(document.body, /ehall_prepare/u);
  await closeAssistantContext(context);
});

test("技能名称与内容不合法时拒绝写入", async () => {
  const { context } = await createContext();
  await assert.rejects(() => learnSkill(context.vault, { name: "Bad Name", description: "x", body: "y" }), /只能使用小写字母/);
  await assert.rejects(() => learnSkill(context.vault, { name: "ok-name", description: "", body: "y" }), /技能描述长度/);
  await assert.rejects(() => learnSkill(context.vault, { name: "ok-name", description: "x", body: "  " }), /技能内容不能为空/);
  await closeAssistantContext(context);
});

test("工具权限：读取允许，发送与删除询问，不可撤销事务拒绝", async () => {
  const { context } = await createContext();
  const policy = createPermissionPolicy({ vault: context.vault });
  const check = (name, input = {}) => policy({
    tool: { name, description: "", inputSchema: { type: "object" } },
    input,
    context: { runId: "r", step: 1, toolCallId: "c", idempotencyKey: "i", signal: new AbortController().signal, report: () => undefined },
  });

  assert.equal(await check("vault_search"), "allow");
  assert.equal(await check("mail_draft_create"), "allow");
  assert.equal(await check("vault_write"), "allow");
  assert.equal(await check("unknown_tool"), "deny");

  const remove = await check("vault_remove", { path: "notes/one.md" });
  assert.equal(remove.decision, "ask");
  assert.match(remove.grantKey, /vault\.remove/u);

  const send = await check("mail_send", { id: "d1" });
  assert.equal(send.decision, "ask");
  assert.equal(send.grantKey, "mail.send:d1");

  const submit = await check("ehall_submit", { serviceId: "transcript" });
  assert.equal(submit.decision, "ask");
  assert.equal(submit.grantKey, "ehall.submit:transcript");

  assert.equal(await check("ehall_submit", { serviceId: "course-withdraw" }), "deny");
  assert.equal(await check("ehall_submit", { serviceId: "application-withdraw" }), "deny");
  await closeAssistantContext(context);
});

test("个人数据库拒绝越界写入", async () => {
  const root = await mkdtemp(join(tmpdir(), "may-assistant-vault-guard-"));
  roots.push(root);
  const vault = await Vault.open(join(root, "vault"));
  await vault.write("notes/ok.md", "# ok\n");
  await assert.rejects(() => vault.write("../outside.md", "x"), /非法片段/);
  await assert.rejects(() => vault.read("/etc/passwd"), /相对路径/);
});
