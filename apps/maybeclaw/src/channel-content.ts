import type { ChannelAttachment, ChannelInput } from "./channel-store.js";
import type { ChannelAdapter, ChannelAttachmentData } from "./channels.js";
import type { ContentPart } from "@sortedyuan/may/core";
import { inspectImage } from "@sortedyuan/media";
import type { GatewayCapabilities, GatewayEntry } from "./gateway-types.js";

export async function readChannelContent(
  adapter: ChannelAdapter,
  input: ChannelInput,
  agents: readonly GatewayCapabilities[],
  signal: AbortSignal,
): Promise<ContentPart[]> {
  const attachments = input.attachments ?? [],
    capabilities = adapter.capabilities;
  if (!capabilities || !adapter.readAttachment) throw new Error("当前渠道不支持读取附件。");
  if (!agents.length) throw new Error("没有可接收附件的目标 Agent。");
  for (const attachment of attachments) {
    if (!capabilities.inputAttachments.includes(attachment.kind))
      throw new Error(`当前渠道不支持读取 ${attachment.kind} 附件。`);
    if (agents.some((agent) => !agent.media.includes(attachment.kind)))
      throw new Error(`目标 Agent 不支持 ${attachment.kind} 附件。请检查目标 Agent 的媒体配置。`);
    if (attachment.size !== undefined && attachment.size > capabilities.maxAttachmentBytes)
      throw new Error("附件大小超过渠道限制。");
  }
  const content: ContentPart[] = [];
  let size = 0;
  for (const attachment of attachments) {
    signal.throwIfAborted();
    const data = await adapter.readAttachment(input, attachment, signal);
    size += data.data.byteLength;
    if (size > capabilities.maxAttachmentBytes) throw new Error("本条消息的附件总大小超过渠道限制。");
    content.push(await channelAttachmentContent(attachment, data, capabilities.maxAttachmentBytes));
  }
  return content;
}
export async function channelAttachmentContent(
  attachment: ChannelAttachment,
  data: ChannelAttachmentData,
  maximum: number,
): Promise<ContentPart> {
  if (!data.data.byteLength || data.data.byteLength > maximum) throw new Error("附件内容为空或超过大小限制。");
  let mediaType = data.mediaType ?? attachment.mediaType ?? "application/octet-stream";
  if (attachment.kind === "image") mediaType = (await inspectImage(data.data)).mediaType;
  if (attachment.kind === "unsupported") throw new Error("无法处理此附件类型。");
  if (attachment.kind === "audio" && !mediaType.startsWith("audio/")) throw new Error("音频附件缺少有效内容类型。");
  if (attachment.kind === "video" && !mediaType.startsWith("video/")) throw new Error("视频附件缺少有效内容类型。");
  const source = { type: "base64" as const, mediaType, data: Buffer.from(data.data).toString("base64") };
  return attachment.kind === "image"
    ? { type: "image", source }
    : attachment.kind === "audio"
      ? { type: "audio", source }
      : { type: "file", source, ...((data.name ?? attachment.name) ? { name: data.name ?? attachment.name } : {}) };
}
export function channelEntry(input: ChannelInput): GatewayEntry {
  return {
    account: input.account,
    conversation: input.conversation,
    kind: input.kind ?? "private",
    ...(input.kind === "group" ? {} : { owner: input.sender }),
    ...(input.threadId ? { threadId: input.threadId } : {}),
  };
}
