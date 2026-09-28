import { randomBytes } from "node:crypto";
import { JsonFile } from "../state/json-file.js";
import {
  emptyMailLedger,
  parseMailLedger,
  shortDigest,
  type MailDraftRecord,
  type MailDraftState,
  type MailLedgerSnapshot,
  type MailMessageRecord,
  type MailMessageState,
} from "./types.js";

export interface FetchedMail {
  /** 稳定标识：优先使用 Message-ID，否则使用 UID。 */
  readonly key: string;
  readonly messageId: string | undefined;
  readonly from: string;
  readonly subject: string;
  readonly date: string;
  readonly internalDate: number;
  readonly text: string;
  readonly hasAttachments: boolean;
}

export interface MailCheckResult {
  readonly newMessages: readonly MailMessageRecord[];
  readonly knownMessages: number;
  readonly checkedAt: number;
  readonly watermark: number | undefined;
}

const MAX_BODY_BYTES = 512 * 1024;
const MAX_DRAFTS = 2_000;
const MAX_DRAFTS_PER_MESSAGE = 5;

/**
 * 邮箱账本：记录哪些邮件已经处理、草稿处于什么状态、哪一版内容被用户确认过。
 * 重复检查邮箱只会补充新邮件，已经记录的邮件不会被再次处理或发送。
 * 草稿正文保存在个人数据库文件里，账本只保存状态与已确认的内容摘要。
 */
export class MailLedger {
  private constructor(private readonly file: JsonFile<MailLedgerSnapshot>) {}

  static async open(path: string): Promise<MailLedger> {
    return new MailLedger(await JsonFile.open(path, emptyMailLedger, parseMailLedger));
  }

  snapshot(): MailLedgerSnapshot {
    return this.file.read();
  }

  watermark(): number | undefined {
    return this.file.read().watermark;
  }

  message(key: string): MailMessageRecord | undefined {
    return this.file.read().messages[key];
  }

  listMessages(options: { state?: MailMessageState; limit?: number } = {}): readonly MailMessageRecord[] {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 200));
    return Object.values(this.file.read().messages)
      .filter((item) => options.state === undefined || item.state === options.state)
      .sort((left, right) => right.internalDate - left.internalDate)
      .slice(0, limit);
  }

  listDrafts(options: { state?: MailDraftState; limit?: number } = {}): readonly MailDraftRecord[] {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 200));
    return Object.values(this.file.read().drafts)
      .filter((item) => options.state === undefined || item.state === options.state)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, limit);
  }

  draft(id: string): MailDraftRecord | undefined {
    return this.file.read().drafts[id];
  }

  /** 记录一次收件检查，返回本次真正新出现的邮件。 */
  recordFetch(messages: readonly FetchedMail[], checkedAt: number): Promise<MailCheckResult> {
    const fresh: MailMessageRecord[] = [];
    return this.file.update((snapshot) => {
      const next = { ...snapshot.messages };
      let watermark = snapshot.watermark;
      for (const mail of messages) {
        if (mail.key === "") throw new Error("邮件缺少稳定标识");
        if (Buffer.byteLength(mail.text, "utf8") > MAX_BODY_BYTES) {
          throw new Error(`邮件正文超过 ${MAX_BODY_BYTES} 字节上限：${mail.subject}`);
        }
        const known = next[mail.key];
        watermark = Math.max(watermark ?? 0, mail.internalDate);
        if (known !== undefined) {
          next[mail.key] = { ...known, preview: preview(mail.text), updatedAt: checkedAt };
          continue;
        }
        const record: MailMessageRecord = {
          key: mail.key,
          messageId: mail.messageId,
          from: mail.from,
          subject: mail.subject.slice(0, 500),
          date: mail.date,
          internalDate: mail.internalDate,
          preview: preview(mail.text),
          hasAttachments: mail.hasAttachments,
          state: "new",
          draftId: undefined,
          sentMessageId: undefined,
          sentAt: undefined,
          firstSeenAt: checkedAt,
          updatedAt: checkedAt,
        };
        next[mail.key] = record;
        fresh.push(record);
      }
      return { ...snapshot, messages: next, lastCheckedAt: checkedAt, watermark };
    }).then((snapshot) => ({
      newMessages: fresh,
      knownMessages: Object.keys(snapshot.messages).length - fresh.length,
      checkedAt,
      watermark: snapshot.watermark,
    }));
  }

  markMessage(key: string, state: MailMessageState, extra: { draftId?: string } = {}): Promise<MailMessageRecord> {
    return this.file.update((snapshot) => {
      const record = snapshot.messages[key];
      if (record === undefined) throw new Error(`邮件不在账本中：${key}`);
      const updated: MailMessageRecord = {
        ...record,
        state,
        ...(extra.draftId === undefined ? {} : { draftId: extra.draftId }),
        updatedAt: Date.now(),
      };
      return { ...snapshot, messages: { ...snapshot.messages, [key]: updated } };
    }).then((snapshot) => snapshot.messages[key]!);
  }

  createDraft(input: { file: string; inReplyTo?: string | undefined; digest: string }): Promise<MailDraftRecord> {
    const now = Date.now();
    const id = newDraftId();
    return this.file.update((snapshot) => {
      if (Object.keys(snapshot.drafts).length >= MAX_DRAFTS) throw new Error(`草稿数量超过 ${MAX_DRAFTS}`);
      if (input.inReplyTo !== undefined && snapshot.messages[input.inReplyTo] === undefined) {
        throw new Error(`原邮件不在账本中：${input.inReplyTo}`);
      }
      if (input.inReplyTo !== undefined) {
        const related = Object.values(snapshot.drafts)
          .filter((draft) => draft.inReplyTo === input.inReplyTo && draft.state === "draft");
        if (related.length >= MAX_DRAFTS_PER_MESSAGE) {
          throw new Error(`这封邮件已经有 ${related.length} 份未发送草稿，请先处理已有草稿`);
        }
      }
      const record: MailDraftRecord = {
        id,
        file: input.file,
        inReplyTo: input.inReplyTo,
        digest: input.digest,
        confirmedDigest: undefined,
        confirmedAt: undefined,
        state: "draft",
        sentMessageId: undefined,
        sentAt: undefined,
        createdAt: now,
        updatedAt: now,
        revision: 1,
      };
      return { ...snapshot, drafts: { ...snapshot.drafts, [id]: record } };
    }).then((snapshot) => snapshot.drafts[id]!);
  }

  /**
   * 记录文件当前内容。内容变化后旧确认立即失效，
   * 这样用户直接修改 Markdown 文件也不会让旧确认继续有效。
   */
  syncDraft(id: string, digest: string): Promise<MailDraftRecord> {
    const current = this.draft(id);
    if (current === undefined) throw new Error(`草稿不存在：${id}`);
    if (current.state !== "draft") throw new Error(`草稿已发送，不能再修改：${id}`);
    if (current.digest === digest) return Promise.resolve(current);
    const unchanged = current.confirmedDigest === digest;
    return this.file.update((snapshot) => ({
      ...snapshot,
      drafts: {
        ...snapshot.drafts,
        [id]: {
          ...current,
          digest,
          confirmedDigest: unchanged ? current.confirmedDigest : undefined,
          confirmedAt: unchanged ? current.confirmedAt : undefined,
          updatedAt: Date.now(),
          revision: current.revision + 1,
        },
      },
    })).then((snapshot) => snapshot.drafts[id]!);
  }

  /** 记录用户确认的内容版本，内容不一致时拒绝。 */
  confirmDraft(id: string, digest: string): Promise<MailDraftRecord> {
    const current = this.draft(id);
    if (current === undefined) throw new Error(`草稿不存在：${id}`);
    if (current.state !== "draft") throw new Error(`草稿已发送，无需确认：${id}`);
    if (digest !== current.digest) {
      throw new Error(
        `草稿已改动，确认版本 ${shortDigest(digest)} 与当前版本 ${shortDigest(current.digest)} 不一致，请重新核对`,
      );
    }
    return this.file.update((snapshot) => ({
      ...snapshot,
      drafts: { ...snapshot.drafts, [id]: { ...current, confirmedDigest: digest, confirmedAt: Date.now() } },
    })).then((snapshot) => snapshot.drafts[id]!);
  }

  markSent(id: string, sent: { messageId: string; sentAt: number }): Promise<MailDraftRecord> {
    const current = this.draft(id);
    if (current === undefined) throw new Error(`草稿不存在：${id}`);
    return this.file.update((snapshot) => {
      const record: MailDraftRecord = { ...current, state: "sent", sentMessageId: sent.messageId, sentAt: sent.sentAt };
      return { ...snapshot, drafts: { ...snapshot.drafts, [id]: record } };
    }).then((snapshot) => snapshot.drafts[id]!);
  }

  /** 归档草稿；原邮件同时标记为已处理。 */
  archiveDraft(id: string): Promise<MailDraftRecord> {
    const current = this.draft(id);
    if (current === undefined) throw new Error(`草稿不存在：${id}`);
    if (current.state === "draft" && current.confirmedDigest !== current.digest) {
      throw new Error(`草稿 ${id} 未被确认，不能标记为已处理`);
    }
    const now = Date.now();
    return this.file.update((snapshot) => {
      const drafts = { ...snapshot.drafts, [id]: { ...current, state: "archived" as const, updatedAt: now } };
      const messages = current.inReplyTo === undefined || snapshot.messages[current.inReplyTo] === undefined
        ? snapshot.messages
        : {
            ...snapshot.messages,
            [current.inReplyTo]: archivedMessage(snapshot.messages[current.inReplyTo]!, now),
          };
      return { ...snapshot, messages, drafts };
    }).then((snapshot) => snapshot.drafts[id]!);
  }

  /** 界面显示用的待办数量。 */
  pending(): { drafts: number; confirmed: number; unhandledMail: number } {
    const snapshot = this.file.read();
    const drafts = Object.values(snapshot.drafts).filter((draft) => draft.state === "draft");
    return {
      drafts: drafts.length,
      confirmed: drafts.filter((draft) => draft.confirmedDigest === draft.digest).length,
      unhandledMail: Object.values(snapshot.messages).filter((message) => message.state === "new").length,
    };
  }
}

function newDraftId(): string {
  return `d${randomBytes(5).toString("hex")}`;
}

function archivedMessage(message: MailMessageRecord, now: number): MailMessageRecord {
  return { ...message, state: "archived", updatedAt: now };
}

function preview(text: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  return normalized.length <= 400 ? normalized : `${normalized.slice(0, 399)}…`;
}
