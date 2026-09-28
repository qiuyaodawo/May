import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { simpleParser } from "mailparser";
import { SMTPServer } from "smtp-server";
import { Mailbox } from "../dist/mail/mailbox.js";
import { MailLedger } from "../dist/mail/ledger.js";
import { SmtpSender } from "../dist/mail/smtp.js";
import { Vault } from "../dist/vault/vault.js";

const roots = [];
const servers = [];

async function createMailbox(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "may-assistant-mail-"));
  roots.push(root);
  const vault = await Vault.open(join(root, "vault"));
  const ledger = await MailLedger.open(join(root, "mail-ledger.json"));
  let smtpSettings;
  if (options.smtp === true) {
    const received = [];
    const server = new SMTPServer({
      authOptional: true,
      disabledCommands: ["STARTTLS"],
      onAuth(auth, _session, callback) {
        callback(null, { user: auth.username });
      },
      onData(stream, session, callback) {
        const chunks = [];
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("end", () => {
          received.push({ from: session.envelope.mailFrom?.address, to: session.envelope.rcptTo.map((item) => item.address), raw: Buffer.concat(chunks).toString("utf8") });
          callback();
        });
      },
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const port = server.server.address().port;
    smtpSettings = { host: "127.0.0.1", port, secure: false, user: "me@example.com", password: "secret", address: "me@example.com" };
    return { root, vault, ledger, mailbox: new Mailbox({ vault, ledger, imap: undefined, smtp: new SmtpSender(smtpSettings), address: "me@example.com" }), received };
  }
  return { root, vault, ledger, mailbox: new Mailbox({ vault, ledger, imap: undefined, smtp: undefined, address: undefined }) };
}

after(async () => {
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test("重复收件只登记一次，水位随最新邮件前进", async () => {
  const { ledger } = await createMailbox();
  const mail = {
    key: "<a@example.com>",
    messageId: "<a@example.com>",
    from: "teacher@example.edu.cn",
    subject: "报名通知",
    date: "2026-09-01T00:00:00.000Z",
    internalDate: 1_757_000_000_000,
    text: "请在十月一号前完成报名。",
    hasAttachments: false,
  };
  const first = await ledger.recordFetch([mail], 1000);
  assert.equal(first.newMessages.length, 1);
  assert.equal(ledger.watermark(), mail.internalDate);

  const second = await ledger.recordFetch([mail], 2000);
  assert.equal(second.newMessages.length, 0);
  assert.equal(second.knownMessages, 1);
  assert.equal(ledger.listMessages({ state: "new" }).length, 1);
});

test("草稿写入个人数据库，内容改动后旧确认失效", async () => {
  const { mailbox, vault } = await createMailbox();
  const view = await mailbox.createDraft({
    to: ["teacher@example.edu.cn"],
    subject: "关于报名的回复",
    body: "老师您好，我会按时报名。\n\n张三",
  });
  assert.equal(view.record.state, "draft");
  const file = await readFile(join(vault.root, view.record.file), "utf8");
  assert.match(file, /关于报名的回复/);
  assert.match(file, /老师您好/);

  const confirmed = await mailbox.confirmDraft(view.record.id);
  assert.equal(confirmed.confirmed, true);

  const updated = await mailbox.updateDraft(view.record.id, { body: "老师您好，我会按时报名。\n\n张三\n学号 2026001234" });
  assert.equal(updated.confirmed, false);
  assert.notEqual(updated.record.digest, confirmed.record.digest);
  await assert.rejects(() => mailbox.sendDraft(view.record.id), /没有被确认/);
});

test("直接修改草稿文件同样会让确认失效", async () => {
  const { mailbox, vault } = await createMailbox();
  const view = await mailbox.createDraft({ to: ["a@example.com"], subject: "测试", body: "第一版" });
  await mailbox.confirmDraft(view.record.id);
  const original = await readFile(join(vault.root, view.record.file), "utf8");
  await vault.write(view.record.file, original.replace("第一版", "第二版"));
  await assert.rejects(() => mailbox.sendDraft(view.record.id), /还没有被确认/);
  const reread = await mailbox.readDraft(view.record.id);
  assert.equal(reread.content.body, "第二版");
  assert.equal(reread.confirmed, false);
});

test("确认摘要不匹配时拒绝确认", async () => {
  const { mailbox } = await createMailbox();
  const view = await mailbox.createDraft({ to: ["a@example.com"], subject: "测试", body: "内容" });
  await assert.rejects(
    () => mailbox.confirmDraft(view.record.id, "0".repeat(64)),
    /与当前版本/,
  );
  const ok = await mailbox.confirmDraft(view.record.id, view.record.digest);
  assert.equal(ok.record.confirmedDigest, ok.record.digest);
});

test("发送的内容与确认版本一致，并且不会重复发送", async () => {
  const { mailbox, received, vault } = await createMailbox({ smtp: true });
  const view = await mailbox.createDraft({
    to: ["teacher@example.edu.cn"],
    cc: ["advisor@example.edu.cn"],
    subject: "关于报名的回复",
    body: "老师您好，\n我会按时报名。\n\n张三\n学号 2026001234",
  });
  await mailbox.confirmDraft(view.record.id);

  const sent = await mailbox.sendDraft(view.record.id);
  assert.equal(sent.alreadySent, false);
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].to, ["teacher@example.edu.cn", "advisor@example.edu.cn"]);
  const parsed = await simpleParser(received[0].raw);
  assert.equal(parsed.subject, "关于报名的回复");
  assert.equal(parsed.to?.text, "teacher@example.edu.cn");
  assert.equal(parsed.cc?.text, "advisor@example.edu.cn");
  assert.equal(parsed.text, view.content.body);
  assert.equal(parsed.messageId, sent.sent.messageId);

  const again = await mailbox.sendDraft(view.record.id);
  assert.equal(again.alreadySent, true);
  assert.equal(received.length, 1);

  const status = await mailbox.ledger().pending();
  assert.equal(status.drafts, 0);
});

test("归档邮件写入个人数据库并标记为已处理", async () => {
  const { mailbox, ledger, vault } = await createMailbox();
  await ledger.recordFetch([{
    key: "<b@example.com>",
    messageId: "<b@example.com>",
    from: "notice@example.edu.cn",
    subject: "办事通知",
    date: "2026-09-20T00:00:00.000Z",
    internalDate: 1_790_000_000_000,
    text: "请在办事大厅提交材料。",
    hasAttachments: true,
  }], 1000);
  const result = await mailbox.archiveMessage("<b@example.com>", "已转成待办");
  assert.equal(result.state, "archived");
  const content = await readFile(join(vault.root, result.file), "utf8");
  assert.match(content, /notice@example\.edu\.cn/);
  assert.match(content, /附件：有/);
  assert.match(content, /处理说明：已转成待办/);
  assert.equal(ledger.pending().unhandledMail, 0);
  assert.ok((await vault.search("办事通知")).length >= 1);
});

test("草稿与地址校验", async () => {
  const { mailbox } = await createMailbox();
  await assert.rejects(() => mailbox.createDraft({ to: ["not-an-address"], subject: "x", body: "y" }), /不是合法邮箱地址/);
  await assert.rejects(() => mailbox.createDraft({ to: [], subject: "x", body: "y" }), /至少需要一个收件人/);
  await assert.rejects(() => mailbox.createDraft({ to: ["a@example.com"], subject: " ", body: "y" }), /主题不能为空/);
  await assert.rejects(() => mailbox.createDraft({ to: ["a@example.com"], subject: "x", body: "  " }), /正文不能为空/);
  await assert.rejects(() => mailbox.readDraft("d0000000"), /草稿不存在/);
});

test("没有 SMTP 配置时拒绝发送", async () => {
  const { mailbox } = await createMailbox();
  const view = await mailbox.createDraft({ to: ["a@example.com"], subject: "x", body: "y" });
  await mailbox.confirmDraft(view.record.id);
  await assert.rejects(() => mailbox.sendDraft(view.record.id), /没有配置 SMTP/);
});
