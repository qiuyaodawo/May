import type { MayConfig } from "@may/config";

export type GroupTrigger = "explicit" | "all";
export interface EntranceTrigger { conversation: string; threadId?: string; trigger: GroupTrigger }
export interface ChannelAccessSettings { allowUsers: string[]; allowGroups?: string[]; groupTrigger?: GroupTrigger; entranceTriggers?: EntranceTrigger[] }
export interface TelegramSettings extends ChannelAccessSettings { enabled: boolean; botToken?: string; botTokenEnv?: string }
export interface FeishuSettings extends ChannelAccessSettings { enabled: boolean; appId: string; appSecret?: string; appSecretEnv?: string }
export interface HostSettings {
  maxConcurrent: number;
  telegram?: TelegramSettings;
  feishu?: FeishuSettings;
}

/** Reject misspelled security settings rather than silently enabling a wider policy. */
export function hostSettings(config: MayConfig): HostSettings {
  const app = object(config.apps?.maybeclaw ?? {}, "apps.maybeclaw", ["version", "runBudget", "server", "channels", "agents", "access"]);
  const server = object(app.server ?? {}, "maybeclaw.server", ["maxConcurrent", "idleMs", "shutdownMs", "approvalMs", "publicOrigin", "auth"]);
  const maxConcurrent = server.maxConcurrent ?? 1;
  if (!Number.isSafeInteger(maxConcurrent) || (maxConcurrent as number) < 1 || (app.version !== 2 && (maxConcurrent as number) > 4)) throw new Error("maxConcurrent must be positive; legacy task hosts support 1..4");
  const channels = object(app.channels ?? {}, "maybeclaw.channels", ["telegram", "feishu"]);
  const result: HostSettings = { maxConcurrent: maxConcurrent as number };
  for (const name of ["telegram", "feishu"] as const) {
    if (channels[name] === undefined) continue;
    const accessKeys = ["allowUsers", "allowGroups", "groupTrigger", "entranceTriggers"];
    const raw = object(channels[name], name, name === "telegram" ? ["enabled", "botToken", "botTokenEnv", ...accessKeys] : ["enabled", "appId", "appSecret", "appSecretEnv", ...accessKeys]);
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") throw new Error(`${name}.enabled must be boolean`);
    const enabled = raw.enabled === true;
    const users = raw.allowUsers ?? [];
    if (!Array.isArray(users) || users.some((v) => typeof v !== "string" || !(name === "telegram" ? /^[1-9][0-9]{0,19}$/ : /^ou_[A-Za-z0-9_-]{1,128}$/).test(v))) throw new Error(`${name} needs an explicit allowUsers list of user IDs`);
    const groups = raw.allowGroups ?? [];
    const groupPattern = name === "telegram" ? /^-[1-9][0-9]{0,19}$/ : /^oc_[A-Za-z0-9_-]{1,128}$/;
    if (!Array.isArray(groups) || groups.some((v) => typeof v !== "string" || !groupPattern.test(v))) throw new Error(`Invalid ${name}.allowGroups`);
    if (enabled && users.length === 0 && groups.length === 0) throw new Error(`${name} needs an explicit allowUsers or allowGroups list`);
    const groupTrigger = raw.groupTrigger ?? "explicit";
    if (groupTrigger !== "explicit" && groupTrigger !== "all") throw new Error(`Invalid ${name}.groupTrigger`);
    const entranceTriggers = raw.entranceTriggers ?? [];
    if (!Array.isArray(entranceTriggers)) throw new Error(`Invalid ${name}.entranceTriggers`);
    const entrances = entranceTriggers.map(value => {
      const entrance = object(value, `${name}.entranceTriggers`, ["conversation", "threadId", "trigger"]);
      if (typeof entrance.conversation !== "string" || !groups.includes(entrance.conversation) || !["explicit", "all"].includes(entrance.trigger as string)) throw new Error(`Invalid ${name} entrance trigger`);
      if (entrance.threadId !== undefined && (typeof entrance.threadId !== "string" || !entrance.threadId || entrance.threadId.length > 256)) throw new Error(`Invalid ${name} entrance threadId`);
      return entrance as unknown as EntranceTrigger;
    });
    if (new Set(entrances.map(value => JSON.stringify([value.conversation, value.threadId]))).size !== entrances.length) throw new Error(`Duplicate ${name} entrance trigger`);
    const access: ChannelAccessSettings = { allowUsers: [...new Set(users as string[])], allowGroups: [...new Set(groups as string[])], groupTrigger, entranceTriggers: entrances };
    if (name === "telegram") result.telegram = { enabled, ...access, ...credential(raw, "botToken", "botTokenEnv", "MAYBECLAW_TELEGRAM_TOKEN") };
    else {
      const appId = raw.appId ?? "";
      if (typeof appId !== "string" || (enabled && !/^cli_[0-9a-fA-F]{16}$/.test(appId))) throw new Error("feishu.appId must be a self-built app ID");
      result.feishu = { enabled, appId, ...access, ...credential(raw, "appSecret", "appSecretEnv", "MAYBECLAW_FEISHU_SECRET") };
    }
  }
  return result;
}

function credential(raw: Record<string, unknown>, key: string, envKey: string, fallback: string): Record<string, string> {
  if (raw[key] !== undefined && raw[envKey] !== undefined) throw new Error(`Configure either ${key} or ${envKey}, not both`);
  if (raw[key] !== undefined) {
    const value = raw[key];
    if (typeof value !== "string" || !value.trim() || /\s/.test(value) || value.length > 4096) throw new Error(`Invalid ${key}: expected a nonempty credential without whitespace`);
    return { [key]: value };
  }
  return { [envKey]: envName(raw[envKey], fallback, envKey, key) };
}

/** Trusted host use only. Do not include returned credentials in logs or task specs. */
export function channelSecret(value: string | undefined, name: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (value !== undefined) return value;
  if (!name) throw new Error("Missing channel credential source");
  return secretFromEnv(name, env);
}

export function secretFromEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (!value?.trim() || /[\r\n]/.test(value)) throw new Error(`Set credential environment variable ${name}`);
  return value;
}
function envName(value: unknown, fallback: string, field: string, directField: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) throw new Error(`Invalid ${field}: expected an environment variable name; use ${directField} for a literal credential`);
  return value;
}
function object(value: unknown, label: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`Invalid ${label} settings`);
  return value as Record<string, unknown>;
}
