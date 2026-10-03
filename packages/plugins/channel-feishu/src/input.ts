import type { ChannelAttachment, ChannelInput } from "@may/plugin-delivery";

export interface FeishuEvent {
  event_id?: string; sender?: { sender_type?: string; sender_id?: { open_id?: string } };
  message?: { message_id?: string; chat_id?: string; chat_type?: string; message_type?: string; content?: string; thread_id?: string; root_id?: string; parent_id?: string; create_time?: string; update_time?: string;
    mentions?: Array<{ key: string; id: { open_id?: string }; name?: string }> };
}
export function feishuInput(event: FeishuEvent, account: string, botOpenId?: string): ChannelInput | undefined {
  const message = event.message, sender = event.sender?.sender_id?.open_id;
  if (event.sender?.sender_type !== "user" || !sender || !["p2p", "group"].includes(message?.chat_type ?? "") || !message?.chat_id || !message.message_id || typeof message.content !== "string" || message.content.length > 32_768) return undefined;
  let content: Record<string, unknown>;
  try { content = JSON.parse(message.content) as Record<string, unknown>; } catch { return undefined; }
  if (!content || typeof content !== "object" || Array.isArray(content)) return undefined;
  let text = typeof content.text === "string" ? content.text : "";
  const mentions = message.mentions?.filter(mention => botOpenId && mention.id.open_id === botOpenId) ?? [];
  for (const mention of mentions) text = text.replaceAll(mention.key, "");
  text = text.trim();
  const attachments: ChannelAttachment[] = [];
  if (message.message_type !== "text") {
    const type = message.message_type;
    const attachmentKind: ChannelAttachment["kind"] = type === "image" ? "image" : type === "file" ? "file" : type === "audio" ? "audio" : type === "media" ? "video" : "unsupported";
    const key = type === "image" ? content.image_key : content.file_key;
    attachments.push({ id: typeof key === "string" && key ? key : message.message_id, kind: attachmentKind,
      ...(typeof content.file_name === "string" && content.file_name ? { name: content.file_name } : {}),
      ...(typeof content.file_size === "number" ? { size: content.file_size } : {}),
      source: { platform: "feishu", fileId: typeof key === "string" && key ? key : message.message_id, messageId: message.message_id } });
  }
  if (text.length > 16_384 || (!text && !attachments.length)) return undefined;
  return { account, eventId: event.event_id ?? message.message_id, sender, conversation: message.chat_id, text,
    kind: message.chat_type === "p2p" ? "private" : "group", messageId: message.message_id, eventType: "message", mentioned: mentions.length > 0,
    ...(message.thread_id ? { threadId: message.thread_id } : {}), ...(message.parent_id ? { replyTo: message.parent_id } : {}),
    ...(message.create_time ? { occurredAt: message.create_time } : {}), ...(attachments.length ? { attachments } : {}) };
}
export interface FeishuRecallEvent { event_id?: string; message_id?: string; chat_id?: string; recall_time?: string }
export interface FeishuMemberEvent { event_id?: string; chat_id?: string; create_time?: string; users?: Array<{ user_id?: { open_id?: string } }> }
export function feishuMemberInputs(event: FeishuMemberEvent, account: string, active: boolean): ChannelInput[] {
  if (!event.event_id || !event.chat_id || !event.users?.length) throw new Error("Feishu member change lacks its event, chat, or members");
  return [...new Set(event.users.map(user => {
    if (!user.user_id?.open_id) throw new Error("Feishu member change lacks an open_id");
    return user.user_id.open_id;
  }))].map(sender => ({ account, eventId: `${event.event_id}:${sender}`, sender, conversation: event.chat_id!, kind: "group", text: "",
    eventType: active ? "member-joined" : "member-left", ...(event.create_time ? { occurredAt: event.create_time } : {}) }));
}
export function feishuRecallInput(event: FeishuRecallEvent, original: ChannelInput): ChannelInput {
  if (!event.message_id || event.message_id !== original.messageId || event.chat_id !== original.conversation || (!event.event_id && !event.recall_time)) throw new Error("Feishu recall does not match a recorded message");
  return { ...original, eventId: event.event_id ?? `recall:${event.message_id}:${event.recall_time}`, eventType: "delete", text: "", attachments: [],
    ...(event.recall_time ? { occurredAt: event.recall_time } : {}) };
}
