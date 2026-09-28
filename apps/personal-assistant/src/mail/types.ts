import { createHash } from "node:crypto";

export type MailMessageState = "new" | "drafted" | "sent" | "archived" | "ignored";

export interface MailMessageRecord {
  /** 稳定标识：优先使用 Message-ID，否则使用 UID。 */
  readonly key: string;
  readonly messageId: string | undefined;
  readonly from: string;
  readonly subject: string;
  readonly date: string;
  readonly internalDate: number;
  readonly preview: string;
  readonly hasAttachments: boolean;
  readonly state: MailMessageState;
  readonly draftId: string | undefined;
  readonly sentMessageId: string | undefined;
  readonly sentAt: number | undefined;
  readonly firstSeenAt: number;
  readonly updatedAt: number;
}

export type MailDraftState = "draft" | "sent" | "archived";

/**
 * 草稿内容保存在个人数据库的 Markdown 文件里，这里只保存状态机。
 * digest 由文件内容计算，用户直接改文件也会让旧确认失效。
 */
export interface MailDraftRecord {
  readonly id: string;
  /** 草稿文件在个人数据库中的相对路径。 */
  readonly file: string;
  readonly inReplyTo: string | undefined;
  readonly digest: string;
  readonly confirmedDigest: string | undefined;
  readonly confirmedAt: number | undefined;
  readonly state: MailDraftState;
  readonly sentMessageId: string | undefined;
  readonly sentAt: number | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: number;
}

export interface DraftContent {
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string;
  readonly body: string;
}

export interface MailLedgerSnapshot {
  readonly version: number;
  readonly messages: Readonly<Record<string, MailMessageRecord>>;
  readonly drafts: Readonly<Record<string, MailDraftRecord>>;
  readonly lastCheckedAt: number | undefined;
  /** 已处理邮件中最大的收件内部时间，用于缩小下次检索范围。 */
  readonly watermark: number | undefined;
}

export const MAIL_LEDGER_VERSION = 1;
const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/u;

export function emptyMailLedger(): MailLedgerSnapshot {
  return {
    version: MAIL_LEDGER_VERSION,
    messages: {},
    drafts: {},
    lastCheckedAt: undefined,
    watermark: undefined,
  };
}

export function normalizeAddresses(input: readonly string[], label: string): readonly string[] {
  const addresses = input.map((item) => item.trim()).filter((item) => item !== "");
  for (const address of addresses) {
    if (!ADDRESS.test(address)) throw new Error(`${label}不是合法邮箱地址：${address}`);
    if (address.length > 320) throw new Error(`${label}过长：${address}`);
  }
  if (addresses.length > 50) throw new Error(`${label}数量超过 50`);
  return [...new Set(addresses)];
}

/** 摘要覆盖全部会发出的字段，任何改动都会让已有确认失效。 */
export function draftDigest(content: DraftContent): string {
  return createHash("sha256").update(JSON.stringify({
    to: [...content.to].map((item) => item.toLowerCase()).sort(),
    cc: [...content.cc].map((item) => item.toLowerCase()).sort(),
    subject: content.subject,
    body: content.body,
  })).digest("hex");
}

export function shortDigest(digest: string): string {
  return digest.slice(0, 12);
}

export function parseMailLedger(value: unknown): MailLedgerSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("邮件账本必须是对象");
  }
  const snapshot = value as Record<string, unknown>;
  if (snapshot.version !== MAIL_LEDGER_VERSION) {
    throw new Error(`邮件账本版本不受支持：${String(snapshot.version)}`);
  }
  const { messages, drafts } = snapshot;
  if (!isRecord(messages)) throw new Error("邮件账本 messages 无效");
  if (!isRecord(drafts)) throw new Error("邮件账本 drafts 无效");

  for (const [key, item] of Object.entries(messages)) {
    const message = item as Record<string, unknown>;
    if (key === "" || !isRecord(message) || message.key !== key ||
      typeof message.subject !== "string" || typeof message.from !== "string" ||
      typeof message.internalDate !== "number" || typeof message.firstSeenAt !== "number" ||
      typeof message.updatedAt !== "number" || typeof message.preview !== "string") {
      throw new Error(`邮件账本中的邮件记录无效：${key}`);
    }
    if (!["new", "drafted", "sent", "archived", "ignored"].includes(message.state as string)) {
      throw new Error(`邮件状态无效：${String(message.state)}`);
    }
  }

  for (const [key, item] of Object.entries(drafts)) {
    const draft = item as Record<string, unknown>;
    if (key === "" || !isRecord(draft) || draft.id !== key ||
      typeof draft.file !== "string" || !draft.file.endsWith(".md") || draft.file.startsWith("/") ||
      !isSha256(draft.digest) || typeof draft.createdAt !== "number" ||
      typeof draft.updatedAt !== "number" || typeof draft.revision !== "number") {
      throw new Error(`邮件账本中的草稿记录无效：${key}`);
    }
    if (draft.confirmedDigest !== undefined && !isSha256(draft.confirmedDigest)) {
      throw new Error(`草稿确认摘要无效：${key}`);
    }
    if (!["draft", "sent", "archived"].includes(draft.state as string)) {
      throw new Error(`草稿状态无效：${String(draft.state)}`);
    }
  }

  return {
    version: MAIL_LEDGER_VERSION,
    messages: messages as Record<string, MailMessageRecord>,
    drafts: drafts as Record<string, MailDraftRecord>,
    lastCheckedAt: typeof snapshot.lastCheckedAt === "number" ? snapshot.lastCheckedAt : undefined,
    watermark: typeof snapshot.watermark === "number" ? snapshot.watermark : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
