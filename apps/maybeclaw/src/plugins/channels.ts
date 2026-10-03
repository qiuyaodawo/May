import type { AnyPlugin } from "@may/plugin";
import { createTelegramChannelPlugin } from "@may/plugin-channel-telegram";
import { createFeishuChannelPlugin } from "@may/plugin-channel-feishu";
import { channelSecret, type HostSettings } from "../settings.js";

export function createGatewayChannelPlugins(settings: HostSettings): AnyPlugin[] {
  const plugins: AnyPlugin[] = [];
  if (settings.telegram?.enabled) plugins.push(createTelegramChannelPlugin({ settings: settings.telegram, token: channelSecret(settings.telegram.botToken, settings.telegram.botTokenEnv) }));
  if (settings.feishu?.enabled) plugins.push(createFeishuChannelPlugin({ settings: settings.feishu, secret: channelSecret(settings.feishu.appSecret, settings.feishu.appSecretEnv) }));
  return plugins;
}
