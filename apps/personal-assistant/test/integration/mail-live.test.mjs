import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Mailbox } from "../../dist/mail/mailbox.js";
import { MailLedger } from "../../dist/mail/ledger.js";
import { ImapMailbox } from "../../dist/mail/imap.js";
import { SmtpSender } from "../../dist/mail/smtp.js";
import { Vault } from "../../dist/vault/vault.js";

/**
 * 真实邮箱检查。需要自己提供 IMAP/SMTP 凭据，不会向第三方发送邮件：
 * 收件人固定为登录邮箱本身。没有凭据时整组跳过。
 */
const live = {
  imapHost: process.env.MAY_ASSISTANT_LIVE_IMAP_HOST,
  imapPort: process.env.MAY_ASSISTANT_LIVE_IMAP_PORT,
  imapUser: process.env.MAY_ASSISTANT_LIVE_IMAP_USER,
  imapPassword: process.env.MAY_ASSISTANT_LIVE_IMAP_PASSWORD,
  smtpHost: process.env.MAY_ASSISTANT_LIVE_SMTP_HOST,
  smtpPort: process.env.MAY_ASSISTANT_LIVE_SMTP_PORT,
  smtpUser: process.env.MAY_ASSISTANT_LIVE_SMTP_USER,
  smtpPassword: process.env.MAY_ASSISTANT_LIVE_SMTP_PASSWORD,
  sentMailbox: process.env.MAY_ASSISTANT_LIVE_SENT_MAILBOX,
};
const configured = live.imapHost !== undefined && live.imapUser !== undefined && live.imapPassword !== undefined &&
  live.smtpHost !== undefined && live.smtpUser !== undefined && live.smtpPassword !== undefined;
const options = configured ? {} : { skip: "需要 MAY_ASSISTANT_LIVE_IMAP_* 与 MAY_ASSISTANT_LIVE_SMTP_* 凭据" };
if (!configured) {
  console.error("缺少真实邮箱凭据，跳过集成检查。需要设置 MAY_ASSISTANT_LIVE_IMAP_HOST/PORT/USER/PASSWORD 与 MAY_ASSISTANT_LIVE_SMTP_HOST/PORT/USER/PASSWORD。");
}

test("真实邮箱：收取新邮件不重复登记，确认后的草稿可以发送", options, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "may-assistant-live-mail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = await Vault.open(join(root, "vault"));
  const ledger = await MailLedger.open(join(root, "mail.json"));
  const imapUser = String(live.imapUser);
  const smtpUser = String(live.smtpUser);
  const imapPort = String(live.imapPort ?? "993");
  const smtpPort = String(live.smtpPort ?? "465");
  const mailbox = new Mailbox({
    vault,
    ledger,
    imap: new ImapMailbox({
      host: String(live.imapHost),
      port: Number(imapPort),
      secure: imapPort === "993",
      user: imapUser,
      password: String(live.imapPassword),
      mailbox: "INBOX",
      sentMailbox: live.sentMailbox,
    }),
    smtp: new SmtpSender({
      host: String(live.smtpHost),
      port: Number(smtpPort),
      secure: smtpPort === "465",
      user: smtpUser,
      password: String(live.smtpPassword),
      address: smtpUser,
    }),
    address: smtpUser,
  });

  const first = await mailbox.check({ limit: 5 });
  const second = await mailbox.check({ limit: 5 });
  assert.equal(second.newMessages.length, 0, "重复检查不应再次登记同一封邮件");
  assert.ok(first.knownMessages >= first.newMessages.length);

  const draft = await mailbox.createDraft({
    to: [smtpUser],
    subject: `个人助手自检 ${new Date().toISOString()}`,
    body: "这是一封由个人助手集成检查发送的邮件，收到即表示发送链路正常。",
  });
  await assert.rejects(() => mailbox.sendDraft(draft.record.id), /还没有被确认/);
  await mailbox.confirmDraft(draft.record.id);
  const sent = await mailbox.sendDraft(draft.record.id);
  assert.equal(sent.alreadySent, false);
  assert.match(sent.sent?.messageId ?? "", /@/u);
  assert.match(sent.sent?.raw.toString("utf8") ?? "", /个人助手自检/u);
  const again = await mailbox.sendDraft(draft.record.id);
  assert.equal(again.alreadySent, true);
  mailbox.close();
});
