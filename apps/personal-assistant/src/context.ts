import { RuleBook } from "./growth/rule-book.js";
import { seedSkills } from "./growth/skills.js";
import { ensureCatalog } from "./ehall/catalog.js";
import { EhallService } from "./ehall/service.js";
import { MailLedger } from "./mail/ledger.js";
import { Mailbox } from "./mail/mailbox.js";
import { ImapMailbox } from "./mail/imap.js";
import { SmtpSender } from "./mail/smtp.js";
import type { AssistantSettings } from "./settings.js";
import { Vault } from "./vault/vault.js";

/** 共享依赖：个人数据库、邮箱、办事大厅与规则库由同一个进程持有。 */
export interface AssistantContext {
  readonly settings: AssistantSettings;
  readonly vault: Vault;
  readonly mailbox: Mailbox;
  readonly ehall: EhallService;
  readonly rules: RuleBook;
  /** 邮箱未配置时为 undefined，工具会直接说明没有配置。 */
  readonly mailAvailable: boolean;
}

export interface AssistantContextOptions {
  readonly settings: AssistantSettings;
  /** 测试可以替换个人数据库位置，其余组件按配置创建。 */
  readonly vaultRoot?: string;
  readonly ledgerPath?: string;
}

export async function createAssistantContext(options: AssistantContextOptions): Promise<AssistantContext> {
  const { settings } = options;
  const vault = await Vault.open(options.vaultRoot ?? settings.paths.vault);
  await ensureCatalog(vault);
  const seeded = await seedSkills(vault);
  if (seeded.length > 0) await vault.git.commit(`写入内置技能：${seeded.join("、")}`);
  const ledger = await MailLedger.open(options.ledgerPath ?? settings.paths.mailLedger);
  const mailbox = new Mailbox({
    vault,
    ledger,
    imap: settings.mail === undefined ? undefined : new ImapMailbox({
      host: settings.mail.host,
      port: settings.mail.port,
      secure: settings.mail.secure,
      user: settings.mail.user,
      password: settings.mail.password,
      mailbox: settings.mail.mailbox,
      sentMailbox: settings.mail.sentMailbox === "" ? undefined : settings.mail.sentMailbox,
    }),
    smtp: settings.mail === undefined ? undefined : new SmtpSender({
      host: settings.mail.smtpHost,
      port: settings.mail.smtpPort,
      secure: settings.mail.smtpSecure,
      user: settings.mail.user,
      password: settings.mail.password,
      address: settings.mail.address,
    }),
    address: settings.mail?.address,
  });
  const ehall = await EhallService.open({
    vault,
    browserSettings: {
      profileDirectory: settings.paths.browserProfile,
      headless: settings.ehall.headless,
      timeoutMs: settings.ehall.timeoutMs,
      allowedHosts: settings.ehall.allowedHosts,
    },
    stateFile: options.ledgerPath === undefined ? settings.paths.ehallState : `${options.ledgerPath}.ehall`,
  });
  return {
    settings,
    vault,
    mailbox,
    ehall,
    rules: new RuleBook(vault),
    mailAvailable: settings.mail !== undefined,
  };
}

export async function closeAssistantContext(context: AssistantContext): Promise<void> {
  context.mailbox.close();
  await context.ehall.close();
}
