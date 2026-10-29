import type { AnyPlugin } from "@sortedyuan/may/plugin";
import { createTelegramChannelPlugin } from "../channels/telegram/index.js";
import { createFeishuChannelPlugin } from "../channels/feishu/index.js";
import { channelSecret, type HostSettings } from "../settings.js";

export function createGatewayChannelPlugins(settings: HostSettings): AnyPlugin[] {
  const plugins: AnyPlugin[] = [];
  if (settings.telegram?.enabled) plugins.push(createTelegramChannelPlugin({ settings: settings.telegram, token: channelSecret(settings.telegram.botToken, settings.telegram.botTokenEnv) }));
  if (settings.feishu?.enabled) plugins.push(createFeishuChannelPlugin({ settings: settings.feishu, secret: channelSecret(settings.feishu.appSecret, settings.feishu.appSecretEnv) }));
  return plugins;
}
