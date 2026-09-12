import type { MayConfig } from "@may/config";

export interface TelegramSettings { enabled: boolean; botToken?: string; botTokenEnv?: string; allowUsers: string[] }
export interface FeishuSettings { enabled: boolean; appId: string; appSecret?: string; appSecretEnv?: string; allowUsers: string[] }
export interface HostSettings {
  maxConcurrent: number;
  telegram?: TelegramSettings;
  feishu?: FeishuSettings;
}

/** Reject misspelled security settings rather than silently enabling a wider policy. */
export function hostSettings(config: MayConfig): HostSettings {
  const app = object(config.apps?.maybeclaw ?? {}, "apps.maybeclaw", ["runBudget", "server", "channels"]);
  const server = object(app.server ?? {}, "maybeclaw.server", ["maxConcurrent"]);
  const maxConcurrent = server.maxConcurrent ?? 1;
  if (!Number.isSafeInteger(maxConcurrent) || (maxConcurrent as number) < 1 || (maxConcurrent as number) > 4) throw new Error("maxConcurrent must be 1..4");
  const channels = object(app.channels ?? {}, "maybeclaw.channels", ["telegram", "feishu"]);
  const result: HostSettings = { maxConcurrent: maxConcurrent as number };
  for (const name of ["telegram", "feishu"] as const) {
    if (channels[name] === undefined) continue;
    const raw = object(channels[name], name, name === "telegram" ? ["enabled", "botToken", "botTokenEnv", "allowUsers"] : ["enabled", "appId", "appSecret", "appSecretEnv", "allowUsers"]);
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") throw new Error(`${name}.enabled must be boolean`);
    const enabled = raw.enabled === true;
    const users = raw.allowUsers ?? [];
    if (!Array.isArray(users) || users.some((v) => typeof v !== "string" || !(name === "telegram" ? /^[1-9][0-9]{0,19}$/ : /^ou_[A-Za-z0-9_-]{1,128}$/).test(v)) || (enabled && users.length === 0)) throw new Error(`${name} needs an explicit allowUsers list of user IDs`);
    if (name === "telegram") result.telegram = { enabled, allowUsers: [...new Set(users as string[])], ...credential(raw, "botToken", "botTokenEnv", "MAYBECLAW_TELEGRAM_TOKEN") };
    else {
      const appId = raw.appId ?? "";
      if (typeof appId !== "string" || (enabled && !/^cli_[0-9a-fA-F]{16}$/.test(appId))) throw new Error("feishu.appId must be a self-built app ID");
      result.feishu = { enabled, appId, allowUsers: [...new Set(users as string[])], ...credential(raw, "appSecret", "appSecretEnv", "MAYBECLAW_FEISHU_SECRET") };
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
