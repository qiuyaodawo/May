import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { MayConfig } from "@may/config";

export const APP_CONFIG_NAME = "personal-assistant";

export interface AssistantPaths {
  /** 助手的数据目录。 */
  readonly home: string;
  /** Markdown 个人数据库。 */
  readonly vault: string;
  readonly sessions: string;
  readonly catalog: string;
  readonly mailLedger: string;
  readonly ehallState: string;
  readonly browserProfile: string;
}

export interface MailSettings {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string;
  /** 从环境变量读取，不写入配置文件。 */
  readonly password: string;
  readonly address: string;
  readonly mailbox: string;
  readonly sentMailbox: string;
  readonly smtpHost: string;
  readonly smtpPort: number;
  readonly smtpSecure: boolean;
}

export interface EhallSettings {
  readonly headless: boolean;
  readonly timeoutMs: number;
  /** 允许浏览器访问的办事大厅域名。 */
  readonly allowedHosts: readonly string[];
}

export interface ServerSettings {
  readonly host: string;
  readonly port: number;
  /** 允许手机通过局域网访问；默认只监听 127.0.0.1。 */
  readonly allowLan: boolean;
}

export interface PollSettings {
  readonly enabled: boolean;
  readonly intervalMinutes: number;
}

export interface AssistantSettings {
  readonly paths: AssistantPaths;
  readonly model: { readonly profile: string | undefined };
  readonly mail: MailSettings | undefined;
  readonly ehall: EhallSettings;
  readonly server: ServerSettings;
  readonly poll: PollSettings;
  /** 网页工作台与命令行读取同一个控制令牌。 */
  readonly controlToken: string | undefined;
}

export interface SettingsOverrides {
  readonly home?: string;
  readonly model?: string;
  readonly port?: number;
  readonly host?: string;
  readonly allowLan?: boolean;
  readonly pollEnabled?: boolean;
  readonly headless?: boolean;
  readonly controlToken?: string;
}

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

const DEFAULT_HOME = ".personal-assistant";
const DEFAULT_EHALL_HOSTS = ["ehall.nju.edu.cn"];
const DEFAULT_IMAP = { host: "imap.gmail.com", port: 993, secure: true };
const DEFAULT_SMTP = { host: "smtp.gmail.com", port: 465, secure: true };

/**
 * 读取助手配置。个人信息写在 ~/.may/config.json 的 apps.personal-assistant 下，
 * 口令与控制令牌只从环境变量读取。
 */
export function assistantSettings(
  config: MayConfig,
  env: NodeJS.ProcessEnv = process.env,
  overrides: SettingsOverrides = {},
): AssistantSettings {
  const app = record(config.apps?.[APP_CONFIG_NAME] ?? {}, `apps.${APP_CONFIG_NAME}`, [
    "home", "model", "mail", "ehall", "server", "poll",
  ]);
  const home = resolveHome(overrides.home ?? optionalString(app.home, "home") ?? env.MAY_ASSISTANT_HOME ?? join(homedir(), DEFAULT_HOME));
  const paths: AssistantPaths = {
    home,
    vault: join(home, "vault"),
    sessions: join(home, "sessions"),
    catalog: join(home, "catalog.json"),
    mailLedger: join(home, "mail-ledger.json"),
    ehallState: join(home, "ehall-state.json"),
    browserProfile: join(home, "ehall-profile"),
  };

  const mailConfig = app.mail === undefined ? undefined : record(app.mail, `apps.${APP_CONFIG_NAME}.mail`, [
    "host", "port", "secure", "user", "address", "mailbox", "sentMailbox", "smtpHost", "smtpPort", "smtpSecure",
  ]);
  const password = env.MAY_ASSISTANT_MAIL_PASSWORD;
  const mail: MailSettings | undefined = mailConfig === undefined
    ? undefined
    : {
        host: requiredString(mailConfig.host, "mail.host"),
        port: port(mailConfig.port, DEFAULT_IMAP.port, "mail.port"),
        secure: boolean(mailConfig.secure, DEFAULT_IMAP.secure, "mail.secure"),
        user: requiredString(mailConfig.user, "mail.user"),
        password: password === undefined || password === ""
          ? throwMissing("设置环境变量 MAY_ASSISTANT_MAIL_PASSWORD（Gmail 请使用应用专用密码）")
          : password,
        address: requiredString(mailConfig.address, "mail.address"),
        mailbox: optionalString(mailConfig.mailbox, "mail.mailbox") ?? "INBOX",
        sentMailbox: optionalString(mailConfig.sentMailbox, "mail.sentMailbox") ?? "",
        smtpHost: optionalString(mailConfig.smtpHost, "mail.smtpHost") ?? DEFAULT_SMTP.host,
        smtpPort: port(mailConfig.smtpPort, DEFAULT_SMTP.port, "mail.smtpPort"),
        smtpSecure: boolean(mailConfig.smtpSecure, DEFAULT_SMTP.secure, "mail.smtpSecure"),
      };

  const ehallConfig = app.ehall === undefined ? {} : record(app.ehall, `apps.${APP_CONFIG_NAME}.ehall`, ["headless", "timeoutMs", "allowedHosts"]);
  const allowedHosts = ehallConfig.allowedHosts === undefined
    ? [...DEFAULT_EHALL_HOSTS]
    : hostList(ehallConfig.allowedHosts, "ehall.allowedHosts");
  const ehall: EhallSettings = {
    headless: overrides.headless ?? boolean(ehallConfig.headless, false, "ehall.headless"),
    timeoutMs: timeout(ehallConfig.timeoutMs, 30_000, "ehall.timeoutMs"),
    allowedHosts,
  };

  const serverConfig = app.server === undefined ? {} : record(app.server, `apps.${APP_CONFIG_NAME}.server`, ["host", "port", "allowLan"]);
  const host = overrides.host ?? optionalString(serverConfig.host, "server.host") ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost" && !/^\d{1,3}(\.\d{1,3}){3}$/u.test(host)) {
    throw new SettingsError(`server.host 只能是 127.0.0.1 或局域网地址：${host}`);
  }
  const allowLan = overrides.allowLan ?? boolean(serverConfig.allowLan, false, "server.allowLan");
  if (allowLan && (host === "127.0.0.1" || host === "localhost")) {
    throw new SettingsError("允许局域网访问时必须指定 server.host 为本机局域网地址");
  }
  const server: ServerSettings = {
    host: allowLan ? host : "127.0.0.1",
    port: overrides.port ?? port(serverConfig.port, 3946, "server.port"),
    allowLan,
  };

  const pollConfig = app.poll === undefined ? {} : record(app.poll, `apps.${APP_CONFIG_NAME}.poll`, ["enabled", "intervalMinutes"]);
  const poll: PollSettings = {
    enabled: overrides.pollEnabled ?? boolean(pollConfig.enabled, true, "poll.enabled"),
    intervalMinutes: interval(pollConfig.intervalMinutes, 15, "poll.intervalMinutes"),
  };

  const token = overrides.controlToken ?? env.MAY_ASSISTANT_CONTROL_TOKEN;
  if (token !== undefined && !/^[\x21-\x7e]{32,256}$/u.test(token)) {
    throw new SettingsError("MAY_ASSISTANT_CONTROL_TOKEN 必须是 32 到 256 个可见非空格 ASCII 字符");
  }

  return {
    paths,
    model: { profile: overrides.model ?? optionalString(app.model, "model") },
    mail,
    ehall,
    server,
    poll,
    controlToken: token,
  };
}

export function resolveHome(value: string): string {
  const expanded = value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

function record(value: unknown, label: string, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SettingsError(`${label} 必须是对象`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new SettingsError(`${label} 不认识的配置项：${key}，可用项：${allowed.join("、")}`);
    }
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new SettingsError(`${label} 必须是非空字符串`);
  return value.trim();
}

function requiredString(value: unknown, label: string): string {
  const text = optionalString(value, label);
  if (text === undefined) throw new SettingsError(`缺少配置 ${label}`);
  return text;
}

function boolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new SettingsError(`${label} 必须是 true 或 false`);
  return value;
}

function port(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 65535) {
    throw new SettingsError(`${label} 必须是 1 到 65535 之间的整数`);
  }
  return value as number;
}

function timeout(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1_000 || (value as number) > 600_000) {
    throw new SettingsError(`${label} 必须是 1000 到 600000 之间的毫秒数`);
  }
  return value as number;
}

function interval(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1_440) {
    throw new SettingsError(`${label} 必须是 1 到 1440 之间的分钟数`);
  }
  return value as number;
}

function hostList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw new SettingsError(`${label} 需要 1 到 8 个域名`);
  }
  return value.map((item) => {
    if (typeof item !== "string" || !/^[a-z0-9]+(\.[a-z0-9-]+)+$/u.test(item)) {
      throw new SettingsError(`${label} 只能是小写域名，例如 ehall.nju.edu.cn`);
    }
    return item;
  });
}

function throwMissing(message: string): never {
  throw new SettingsError(message);
}
