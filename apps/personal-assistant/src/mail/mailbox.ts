import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { formatMarkdown, parseMarkdown } from "../vault/frontmatter.js";
import type { Vault } from "../vault/vault.js";
import { ImapMailbox, type ThreadMessage } from "./imap.js";
import { MailLedger, type MailCheckResult } from "./ledger.js";
import { SmtpSender, type SentMail } from "./smtp.js";
import {
  draftDigest,
  normalizeAddresses,
  shortDigest,
  type DraftContent,
  type MailDraftRecord,
  type MailDraftState,
  type MailMessageRecord,
} from "./types.js";

export const DRAFT_DIRECTORY = "mail/drafts";
export const SENT_DIRECTORY = "mail/sent";

export interface MailboxDependencies {
  readonly vault: Vault;
  readonly ledger: MailLedger;
  readonly imap: ImapMailbox | undefined;
  readonly smtp: SmtpSender | undefined;
  readonly address: string | undefined;
}

export interface DraftView {
  readonly record: MailDraftRecord;
  readonly content: DraftContent;
  readonly confirmed: boolean;
}

export interface SendResult {
  readonly record: MailDraftRecord;
  readonly content: DraftContent;
  readonly alreadySent: boolean;
  readonly sent: SentMail | undefined;
}

const MAX_SUBJECT = 500;
const MAX_BODY = 512 * 1024;
const MAX_DRAFTS_PER_MESSAGE = 5;

/**
 * 邮箱能力：持续收取新邮件、把正文存进个人数据库、
 * 只有被用户确认过的那一版草稿才允许发送。
 */
export class Mailbox {
  constructor(private readonly dependencies: MailboxDependencies) {}

  get configured(): boolean {
    return this.dependencies.imap !== undefined && this.dependencies.smtp !== undefined;
  }

  address(): string | undefined {
    return this.dependencies.address;
  }

  /** 检查收件箱。已经记录过的邮件不会再次出现。 */
  async check(options: { limit?: number } = {}): Promise<MailCheckResult> {
    const imap = this.dependencies.imap;
    if (imap === undefined) throw new Error("没有配置 IMAP，无法检查邮箱");
    const messages = await imap.fetchNew({
      since: this.dependencies.ledger.watermark(),
      limit: Math.max(1, Math.min(options.limit ?? 20, 50)),
    });
    return this.dependencies.ledger.recordFetch(messages, Date.now());
  }

  /** 取回一封邮件的完整往来，用于理解上下文。 */
  async thread(key: string): Promise<{ message: MailMessageRecord; history: readonly ThreadMessage[] }> {
    const imap = this.dependencies.imap;
    const message = this.dependencies.ledger.message(key);
    if (message === undefined) throw new Error(`邮件不在账本中：${key}`);
    if (imap === undefined) throw new Error("没有配置 IMAP，无法读取往来");
    const history = await imap.fetchThread(message.subject, message.internalDate);
    return { message, history };
  }

  async createDraft(input: {
    inReplyTo?: string;
    to: readonly string[];
    cc?: readonly string[];
    subject: string;
    body: string;
  }): Promise<DraftView> {
    const content = validateContent(input);
    if (input.inReplyTo !== undefined) {
      const source = this.dependencies.ledger.message(input.inReplyTo);
      if (source === undefined) throw new Error(`原邮件不在账本中：${input.inReplyTo}`);
      const related = this.dependencies.ledger.listDrafts({ state: "draft", limit: 200 })
        .filter((draft) => draft.inReplyTo === input.inReplyTo);
      if (related.length >= MAX_DRAFTS_PER_MESSAGE) {
        throw new Error(`这封邮件已经有 ${related.length} 份未发送草稿，请先处理已有草稿`);
      }
    }
    const digest = draftDigest(content);
    const id = await this.nextDraftId();
    const file = `${DRAFT_DIRECTORY}/${id}.md`;
    await this.writeDraftFile(file, content, { id, inReplyTo: input.inReplyTo, digest });
    const record = await this.dependencies.ledger.createDraft({ file, inReplyTo: input.inReplyTo, digest });
    if (input.inReplyTo !== undefined) {
      await this.dependencies.ledger.markMessage(input.inReplyTo, "drafted", { draftId: record.id });
    }
    await this.dependencies.vault.git.commit(`新建邮件草稿 ${record.id}`);
    return { record, content, confirmed: false };
  }

  /** 读取草稿当前内容，并按文件内容刷新账本摘要。 */
  async readDraft(id: string): Promise<DraftView> {
    const record = this.dependencies.ledger.draft(id);
    if (record === undefined) throw new Error(`草稿不存在：${id}`);
    const content = await this.readDraftFile(record);
    if (record.state !== "draft") {
      return { record, content, confirmed: record.confirmedDigest === record.digest };
    }
    const synced = await this.dependencies.ledger.syncDraft(record.id, draftDigest(content));
    return { record: synced, content, confirmed: synced.confirmedDigest === synced.digest };
  }

  async updateDraft(id: string, patch: {
    to?: readonly string[];
    cc?: readonly string[];
    subject?: string;
    body?: string;
  }): Promise<DraftView> {
    const current = await this.readDraft(id);
    if (current.record.state !== "draft") throw new Error(`草稿已发送，不能再修改：${id}`);
    const content = validateContent({
      to: patch.to ?? current.content.to,
      cc: patch.cc ?? current.content.cc,
      subject: patch.subject ?? current.content.subject,
      body: patch.body ?? current.content.body,
    });
    await this.writeDraftFile(current.record.file, content, current.record);
    const record = await this.dependencies.ledger.syncDraft(id, draftDigest(content));
    return { record, content, confirmed: record.confirmedDigest === record.digest };
  }

  /** 用户核对内容后调用；内容版本不一致时拒绝。 */
  async confirmDraft(id: string, digest?: string): Promise<DraftView> {
    const current = await this.readDraft(id);
    const target = digest ?? current.record.digest;
    const record = await this.dependencies.ledger.confirmDraft(id, target);
    return { record, content: current.content, confirmed: true };
  }

  /**
   * 发送草稿。只会发出账本里被确认的那一版内容；
   * 已经发送过的草稿直接返回记录，不会再发一次。
   */
  async sendDraft(id: string): Promise<SendResult> {
    const view = await this.readDraft(id);
    if (view.record.state !== "draft") {
      if (view.record.sentMessageId !== undefined) {
        return { record: view.record, content: view.content, alreadySent: true, sent: undefined };
      }
      throw new Error(`草稿 ${id} 已归档，不能再发送`);
    }
    if (view.record.confirmedDigest === undefined) {
      throw new Error(`草稿 ${id} 还没有被确认，请在网页或命令行核对内容后确认`);
    }
    if (view.record.confirmedDigest !== view.record.digest) {
      throw new Error(
        `草稿 ${id} 在确认之后被修改（确认 ${shortDigest(view.record.confirmedDigest)}，` +
        `当前 ${shortDigest(view.record.digest)}），请重新确认后再发送`,
      );
    }
    const smtp = this.dependencies.smtp;
    if (smtp === undefined) throw new Error("没有配置 SMTP，无法发送邮件");
    const sent = await smtp.send(view.content, { id: view.record.id, digest: view.record.digest });
    const record = await this.dependencies.ledger.markSent(id, { messageId: sent.messageId, sentAt: sent.date.getTime() });
    const imap = this.dependencies.imap;
    if (imap !== undefined) await imap.appendSent(sent.raw, sent.date);
    await this.archiveSent(record, view.content, sent);
    await this.dependencies.vault.git.commit(`发送邮件 ${record.id}`);
    return { record, content: view.content, alreadySent: false, sent };
  }

  /** 把已发送邮件归档到个人数据库，并归档草稿文件。 */
  async archiveSent(record: MailDraftRecord, content: DraftContent, sent: SentMail): Promise<string> {
    const file = `${SENT_DIRECTORY}/${isoDay(sent.date)}-${record.id}.md`;
    const body = [
      `收件人：${content.to.join("、")}`,
      content.cc.length === 0 ? "" : `抄送：${content.cc.join("、")}`,
      `发送时间：${sent.date.toISOString()}`,
      `Message-ID：${sent.messageId}`,
      "",
      "---",
      "",
      content.body,
      "",
    ].filter((line) => line !== "").join("\n");
    await this.dependencies.vault.write(file, formatMarkdown({
      title: content.subject,
      tags: ["mail", "sent"],
      to: content.to,
      messageId: sent.messageId,
      sentAt: sent.date.toISOString(),
    }, body));
    await this.dependencies.ledger.archiveDraft(record.id);
    return file;
  }

  /** 账本只读访问，供界面和命令行显示状态。 */
  ledger(): MailLedger {
    return this.dependencies.ledger;
  }

  /** 列出草稿及其当前内容。 */
  async listDraftViews(options: { state?: MailDraftState | undefined; limit?: number } = {}): Promise<readonly DraftView[]> {
    const records = this.dependencies.ledger.listDrafts({
      ...(options.state === undefined ? {} : { state: options.state }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    const views: DraftView[] = [];
    for (const record of records) {
      if (await this.dependencies.vault.exists(record.file)) {
        views.push(await this.readDraft(record.id));
        continue;
      }
      throw new Error(`草稿文件缺失：${record.file}`);
    }
    return views;
  }

  /** 把收件归档到个人数据库，并把账本里的这封邮件标记为已处理。 */
  async archiveMessage(key: string, note?: string): Promise<{ file: string; state: string }> {
    const record = this.dependencies.ledger.message(key);
    if (record === undefined) throw new Error(`邮件不在账本中：${key}`);
    const file = `mail/inbox/${isoDay(new Date(record.internalDate))}-${slug(record.subject)}.md`;
    const body = [
      `发件人：${record.from}`,
      `时间：${record.date}`,
      record.hasAttachments ? "附件：有（正文未包含附件内容）" : "",
      note === undefined ? "" : `处理说明：${note}`,
      "",
      "---",
      "",
      record.preview,
      "",
    ].filter((line) => line !== "").join("\n");
    const entry = await this.dependencies.vault.write(file, formatMarkdown({
      title: record.subject,
      tags: ["mail", "inbox"],
      from: record.from,
      receivedAt: record.date,
      messageKey: record.key,
    }, body));
    const updated = await this.dependencies.ledger.markMessage(key, "archived");
    await this.dependencies.vault.git.commit(`归档邮件 ${entry.path}`);
    return { file: entry.path, state: updated.state };
  }

  /** 关闭与邮件服务器之间的连接。 */
  close(): void {
    this.dependencies.smtp?.close();
  }

  private async nextDraftId(): Promise<string> {
    const existing = this.dependencies.ledger.listDrafts({ limit: 200 });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = `d${Date.now().toString(36)}${attempt}${Math.floor(Math.random() * 46656).toString(36)}`;
      if (existing.every((draft) => draft.id !== id)) return id;
    }
    throw new Error("无法生成草稿编号");
  }

  private async writeDraftFile(
    file: string,
    content: DraftContent,
    record: { id: string; inReplyTo?: string | undefined; digest: string },
  ): Promise<void> {
    const body = [
      content.to.length === 0 ? "" : `收件人：${content.to.join("、")}`,
      content.cc.length === 0 ? "" : `抄送：${content.cc.join("、")}`,
      record.inReplyTo === undefined ? "" : `原邮件：${record.inReplyTo}`,
      "",
      content.body,
      "",
    ].filter((line) => line !== "").join("\n");
    await mkdir(join(this.dependencies.vault.root, "mail", "drafts"), { recursive: true });
    await this.dependencies.vault.write(file, formatMarkdown({
      title: content.subject,
      tags: ["mail", "draft"],
      draftId: record.id,
      to: content.to,
      ...(content.cc.length === 0 ? {} : { cc: content.cc }),
      ...(record.inReplyTo === undefined ? {} : { inReplyTo: record.inReplyTo }),
      digest: record.digest,
    }, body));
  }

  private async readDraftFile(record: MailDraftRecord): Promise<DraftContent> {
    const read = await this.dependencies.vault.read(record.file);
    const parsed = parseMarkdown(read.text);
    const data = parsed.data;
    return validateContent({
      to: stringList(data.to),
      cc: stringList(data.cc),
      subject: typeof data.title === "string" ? data.title : headerValue(parsed.body, "主题"),
      body: stripHeader(parsed.body),
    });
  }
}

export function validateContent(input: {
  to: readonly string[];
  cc?: readonly string[];
  subject: string;
  body: string;
}): DraftContent {
  const to = normalizeAddresses(input.to, "收件人");
  if (to.length === 0) throw new Error("草稿至少需要一个收件人");
  const cc = normalizeAddresses(input.cc ?? [], "抄送");
  const subject = input.subject.replace(/\s+/gu, " ").trim();
  if (subject === "") throw new Error("主题不能为空");
  if (subject.length > MAX_SUBJECT) throw new Error(`主题超过 ${MAX_SUBJECT} 个字符`);
  const body = input.body.replace(/\r\n/gu, "\n").replace(/^\n+|\n+$/gu, "");
  if (body.trim() === "") throw new Error("正文不能为空");
  if (body.length > MAX_BODY) throw new Error(`正文超过 ${MAX_BODY} 个字符`);
  return { to, cc, subject, body };
}

export function draftSummary(view: DraftView): string {
  return `${view.record.id} ${view.content.subject} → ${view.content.to.join("、")} ` +
    `(${[shortDigest(view.record.digest), view.confirmed ? "已确认" : "未确认", view.record.state].join(" ")})`;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string" && value.trim() !== "") return value.split(/[、,]/u).map((item) => item.trim());
  return [];
}

function headerValue(body: string, label: string): string {
  const match = new RegExp(`^${label}：(.+)$`, "mu").exec(body);
  return match?.[1]?.trim() ?? "";
}

/** 去掉草稿文件开头的收件人等头部，只保留真正要发出的正文。 */
function stripHeader(body: string): string {
  const lines = body.split("\n");
  let index = 0;
  while (index < lines.length && lines[index]!.trim() === "") index += 1;
  while (index < lines.length && /^(收件人|抄送|原邮件)：/u.test(lines[index]!)) index += 1;
  return lines.slice(index).join("\n").replace(/^\n+/u, "").replace(/\n+$/u, "");
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function slug(subject: string): string {
  const cleaned = subject.replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40);
  return cleaned === "" ? "mail" : cleaned;
}
