import type { ChannelAccessSettings, ChannelAdapter, GroupTrigger } from "./types.js";
import type { ChannelAttachment, ChannelInput } from "./store.js";

export async function boundedJson(response: Response): Promise<unknown> {
  return JSON.parse(Buffer.from(await boundedBytes(response, 1024 * 1024)).toString("utf8"));
}
export async function boundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.body) throw new Error("Empty platform response");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > maximum) throw new Error("Platform response limit exceeded");
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel(); }
}
export function channelAccepts(settings: ChannelAccessSettings, input: Pick<ChannelInput, "sender" | "conversation" | "kind">): boolean {
  return input.kind === "group" ? (settings.allowGroups ?? []).includes(input.conversation) : settings.allowUsers.includes(input.sender);
}
export function channelTrigger(settings: ChannelAccessSettings, input: Pick<ChannelInput, "conversation" | "threadId">): GroupTrigger {
  return settings.entranceTriggers?.find(value => value.conversation === input.conversation && value.threadId === input.threadId)?.trigger
    ?? settings.entranceTriggers?.find(value => value.conversation === input.conversation && value.threadId === undefined)?.trigger
    ?? settings.groupTrigger ?? "explicit";
}
export function checkAttachment(adapter: ChannelAdapter, input: ChannelInput, attachment: ChannelAttachment): void {
  if (input.account !== adapter.account || !adapter.accepts?.(input) || !input.attachments?.some(value => JSON.stringify(value) === JSON.stringify(attachment))) throw new Error("Attachment access denied");
  if (attachment.source.platform !== adapter.name || !adapter.capabilities?.inputAttachments.includes(attachment.kind)) throw new Error("Unsupported channel attachment");
  if (attachment.size !== undefined && attachment.size > adapter.capabilities.maxAttachmentBytes) throw new Error("Channel attachment exceeds the size limit");
}
