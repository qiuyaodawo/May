import type { MayConfig } from "@sortedyuan/may/config";
import {
  readMaybeClawSettings,
  type ChannelSettings,
  type EntranceTrigger,
  type GroupTrigger,
} from "./configuration.js";

export type { EntranceTrigger, GroupTrigger } from "./configuration.js";
export interface ChannelAccessSettings {
  allowUsers: string[];
  allowGroups?: string[];
  groupTrigger?: GroupTrigger;
  entranceTriggers?: EntranceTrigger[];
}
export interface TelegramSettings extends ChannelAccessSettings {
  enabled: boolean;
  botToken?: string;
  botTokenEnv?: string;
}
export interface FeishuSettings extends ChannelAccessSettings {
  enabled: boolean;
  appId: string;
  appSecret?: string;
  appSecretEnv?: string;
}
export interface HostSettings {
  maxConcurrent: number;
  telegram?: TelegramSettings;
  feishu?: FeishuSettings;
}

export function hostSettings(config: MayConfig): HostSettings {
  const settings = readMaybeClawSettings(config);
  const result: HostSettings = { maxConcurrent: settings.server?.maxConcurrent ?? 1 };
  const { telegram, feishu } = settings.channels ?? {};
  if (telegram) {
    result.telegram = {
      enabled: telegram.enabled === true,
      ...channelAccess("telegram", telegram),
      ...(telegram.botToken === undefined
        ? { botTokenEnv: telegram.botTokenEnv ?? "MAYBECLAW_TELEGRAM_TOKEN" }
        : { botToken: telegram.botToken }),
    };
  }
  if (feishu) {
    result.feishu = {
      enabled: feishu.enabled === true,
      appId: feishu.appId ?? "",
      ...channelAccess("feishu", feishu),
      ...(feishu.appSecret === undefined
        ? { appSecretEnv: feishu.appSecretEnv ?? "MAYBECLAW_FEISHU_SECRET" }
        : { appSecret: feishu.appSecret }),
    };
  }
  return result;
}

function channelAccess(name: string, channel: ChannelSettings): ChannelAccessSettings {
  const groups = [...(channel.allowGroups ?? [])];
  const entranceTriggers = [...(channel.entranceTriggers ?? [])];
  for (const entrance of entranceTriggers) {
    if (!groups.includes(entrance.conversation))
      throw new Error(`${name} entrance trigger ${entrance.conversation} is not listed in allowGroups`);
  }
  if (
    new Set(entranceTriggers.map((value) => JSON.stringify([value.conversation, value.threadId]))).size !==
    entranceTriggers.length
  ) {
    throw new Error(`Duplicate ${name} entrance trigger`);
  }
  return {
    allowUsers: [...(channel.allowUsers ?? [])],
    allowGroups: groups,
    groupTrigger: channel.groupTrigger ?? "explicit",
    entranceTriggers,
  };
}

/** Trusted host use only. Do not include returned credentials in logs or task specs. */
export function channelSecret(
  value: string | undefined,
  name: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (value !== undefined) return value;
  if (!name) throw new Error("Missing channel credential source");
  return secretFromEnv(name, env);
}

export function secretFromEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (!value?.trim() || /[\r\n]/.test(value)) throw new Error(`Set credential environment variable ${name}`);
  return value;
}
