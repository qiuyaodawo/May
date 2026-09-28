import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { FetchedMail } from "./ledger.js";

export interface ImapSettings {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string;
  readonly password: string;
  /** 收件箱路径，Gmail 为 INBOX。 */
  readonly mailbox: string;
  /** 保存已发送邮件的文件夹；留空表示不保存。 */
  readonly sentMailbox: string | undefined;
}

export interface FetchOptions {
  /** 只取这个内部时间之后到达的邮件；首次运行时回看一周。 */
  readonly since: number | undefined;
  readonly limit: number;
}

export interface ThreadMessage extends FetchedMail {
  readonly direction: "incoming" | "outgoing";
}

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const THREAD_WINDOW_MS = 1000 * 60 * 60 * 24 * 30;
const FIRST_LOOKBACK_MS = 1000 * 60 * 60 * 24 * 7;

/**
 * IMAP 收件箱访问。使用 Message-ID 作为稳定标识，
 * 这样服务器重新分配 UID 时也不会把同一封邮件当成新邮件。
 */
export class ImapMailbox {
  constructor(private readonly settings: ImapSettings) {}

  async fetchNew(options: FetchOptions): Promise<readonly FetchedMail[]> {
    return this.withClient(async (client) => {
      await client.mailboxOpen(this.settings.mailbox);
      const since = options.since ?? Date.now() - FIRST_LOOKBACK_MS;
      const uids = await client.search({ since: new Date(since - THREAD_WINDOW_MS) }, { uid: true });
      if (uids === false || uids === undefined || uids.length === 0) return [];
      const range = uids.slice(-options.limit);
      const messages: FetchedMail[] = [];
      for await (const message of client.fetch(range, {
        uid: true,
        envelope: true,
        source: { maxLength: MAX_SOURCE_BYTES },
        internalDate: true,
      }, { uid: true })) {
        if (message.source === undefined) continue;
        messages.push(await toFetchedMail(message.uid, internalDateOf(message.internalDate), message.source));
      }
      return messages;
    });
  }

  /** 按主题与日期窗口取回同一往来里的历史邮件。 */
  async fetchThread(subject: string, since: number): Promise<readonly ThreadMessage[]> {
    return this.withClient(async (client) => {
      await client.mailboxOpen(this.settings.mailbox);
      const uids = await client.search({ subject, since: new Date(since - THREAD_WINDOW_MS) }, { uid: true });
      if (uids === false || uids === undefined || uids.length === 0) return [];
      const messages: ThreadMessage[] = [];
      for await (const message of client.fetch(uids.slice(-50), {
        uid: true,
        source: { maxLength: MAX_SOURCE_BYTES },
        internalDate: true,
      }, { uid: true })) {
        if (message.source === undefined) continue;
        const mail = await toFetchedMail(message.uid, internalDateOf(message.internalDate), message.source);
        messages.push({
          ...mail,
          direction: mail.from.toLowerCase().includes(this.settings.user.toLowerCase()) ? "outgoing" : "incoming",
        });
      }
      return messages.sort((left, right) => left.internalDate - right.internalDate);
    });
  }

  /** 把已发送邮件保存到服务器的已发送文件夹。 */
  async appendSent(raw: Buffer, date: Date): Promise<void> {
    const mailbox = this.settings.sentMailbox;
    if (mailbox === undefined || mailbox === "") return;
    await this.withClient(async (client) => {
      await client.append(mailbox, raw, ["\\Seen"], date);
    });
  }

  private async withClient<T>(operation: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = new ImapFlow({
      host: this.settings.host,
      port: this.settings.port,
      secure: this.settings.secure,
      auth: { user: this.settings.user, pass: this.settings.password },
      logger: false,
      disableAutoIdle: true,
    });
    await client.connect();
    try {
      return await operation(client);
    } finally {
      await client.logout().catch(() => client.close());
    }
  }
}

async function toFetchedMail(uid: number, internalDate: number, source: Buffer): Promise<FetchedMail> {
  const parsed = await simpleParser(source, { skipHtmlToText: false });
  const messageId = parsed.messageId?.trim();
  const from = parsed.from?.text?.trim() ?? "";
  return {
    key: messageId === undefined || messageId === "" ? `uid:${uid}` : messageId,
    messageId: messageId === undefined || messageId === "" ? undefined : messageId,
    from,
    subject: (parsed.subject ?? "").replace(/\s+/gu, " ").trim(),
    date: (parsed.date ?? new Date(internalDate)).toISOString(),
    internalDate,
    text: normalizeBody(parsed.text ?? ""),
    hasAttachments: (parsed.attachments ?? []).length > 0,
  };
}

function internalDateOf(value: string | Date | undefined): number {
  if (value === undefined) return Date.now();
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? Date.now() : date.getTime();
}

function normalizeBody(text: string): string {
  return text
    .replace(/\r\n/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
