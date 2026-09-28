import { createTransport, type Transporter } from "nodemailer";
import type { DraftContent } from "./types.js";

export interface SmtpSettings {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string;
  readonly password: string;
  /** 发件人地址，必须是已登录邮箱或已授权别名。 */
  readonly address: string;
}

export interface SentMail {
  readonly messageId: string;
  readonly accepted: readonly string[];
  readonly raw: Buffer;
  readonly date: Date;
}

export class MailSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailSendError";
  }
}

interface CapturableMessage {
  build(): Promise<Buffer>;
}

/**
 * SMTP 发送。发出去的正文就是账本里被确认的那一版，
 * 调用方无法在发送过程中替换内容。
 */
export class SmtpSender {
  private transporter: Transporter | undefined;
  private captured: Buffer | undefined;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly settings: SmtpSettings) {}

  /** 串行发送，同时保证捕获到的是本次发送的完整报文。 */
  send(content: DraftContent, identity: { id: string; digest: string }): Promise<SentMail> {
    const job = this.tail.then(() => this.sendNow(content, identity));
    this.tail = job.then(() => undefined, () => undefined);
    return job;
  }

  private async sendNow(content: DraftContent, identity: { id: string; digest: string }): Promise<SentMail> {
    if (content.to.length === 0) throw new MailSendError("草稿没有收件人");
    const date = new Date();
    const transporter = this.ensureTransporter();
    this.captured = undefined;

    const info = await transporter.sendMail({
      from: this.settings.address,
      to: [...content.to],
      ...(content.cc.length === 0 ? {} : { cc: [...content.cc] }),
      subject: content.subject,
      text: content.body,
      date,
      // 稳定 Message-ID：重试不会产生第二封不同的邮件。
      messageId: `<${identity.id}.${identity.digest.slice(0, 16)}@personal-assistant>`,
    });
    const raw = this.captured;
    this.captured = undefined;
    if (raw === undefined) throw new MailSendError("SMTP 传输没有返回可归档的邮件内容");
    return {
      messageId: info.messageId,
      accepted: info.accepted ?? [],
      raw,
      date,
    };
  }

  async verify(): Promise<void> {
    await this.ensureTransporter().verify();
  }

  close(): void {
    this.transporter?.close();
    this.transporter = undefined;
  }

  private ensureTransporter(): Transporter {
    if (this.transporter !== undefined) return this.transporter;
    const transporter = createTransport({
      host: this.settings.host,
      port: this.settings.port,
      secure: this.settings.secure,
      auth: { user: this.settings.user, pass: this.settings.password },
      tls: { minVersion: "TLSv1.2" },
    });
    // 记录实际发出的报文，归档到个人数据库与已发送文件夹。
    transporter.use("stream", (mail, callback) => {
      const message = mail.message as unknown as CapturableMessage | null;
      if (message === null) {
        callback(new Error("邮件内容没有编译成功"));
        return;
      }
      void message.build().then((raw) => {
        this.captured = raw;
        callback();
      }, callback);
    });
    this.transporter = transporter;
    return transporter;
  }
}
