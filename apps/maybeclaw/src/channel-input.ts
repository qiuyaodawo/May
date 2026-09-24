import type { ChannelAttachment, ChannelInput } from "./channel-store.js";

interface TelegramFile { file_id: string; file_unique_id?: string; file_size?: number; file_name?: string; mime_type?: string }
interface TelegramEntity { type: string; offset: number; length: number; user?: { id?: number } }
interface TelegramMessage {
  message_id?: number; message_thread_id?: number; text?: string; caption?: string; date?: number; edit_date?: number;
  from?: { id?: number; is_bot?: boolean }; sender_chat?: unknown; chat?: { id?: number; type?: string };
  entities?: TelegramEntity[]; caption_entities?: TelegramEntity[]; reply_to_message?: TelegramMessage;
  photo?: TelegramFile[]; document?: TelegramFile; audio?: TelegramFile; voice?: TelegramFile; video?: TelegramFile; animation?: TelegramFile; sticker?: TelegramFile;
}
interface TelegramMember { status?: string; is_member?: boolean; user?: { id?: number; is_bot?: boolean } }
export interface TelegramUpdate { update_id: number; message?: TelegramMessage; edited_message?: TelegramMessage;
  chat_member?: { chat?: { id?: number; type?: string }; date?: number; old_chat_member?: TelegramMember; new_chat_member?: TelegramMember } }

export function telegramMemberInput(update: TelegramUpdate, account: string): ChannelInput | undefined {
  const change = update.chat_member, member = change?.new_chat_member;
  if (!Number.isSafeInteger(update.update_id) || update.update_id < 0 || !change || !["group", "supergroup"].includes(change.chat?.type ?? "")
    || !Number.isSafeInteger(change.chat?.id) || !Number.isSafeInteger(member?.user?.id) || member?.user?.is_bot !== false) return undefined;
  const active = (value: TelegramMember | undefined): boolean | undefined => {
    if (["creator", "administrator", "member"].includes(value?.status ?? "")) return true;
    if (["left", "kicked"].includes(value?.status ?? "")) return false;
    if (value?.status === "restricted" && typeof value.is_member === "boolean") return value.is_member;
    return undefined;
  };
  const before = active(change.old_chat_member), after = active(member);
  if (before === undefined || after === undefined || before === after) return undefined;
  return { account, eventId: String(update.update_id), sender: String(member!.user!.id), conversation: String(change.chat!.id), kind: "group", text: "",
    eventType: after ? "member-joined" : "member-left", ...(change.date === undefined ? {} : { occurredAt: String(change.date * 1000) }) };
}

export function telegramInput(update: TelegramUpdate, account: string, botUsername?: string): ChannelInput | undefined {
  const message = update.edited_message ?? update.message;
  if (!Number.isSafeInteger(update.update_id) || update.update_id < 0 || !message || !["private", "group", "supergroup"].includes(message.chat?.type ?? "")) return undefined;
  if (message.from?.is_bot !== false || message.sender_chat || !Number.isSafeInteger(message.from.id) || !Number.isSafeInteger(message.chat?.id) || !Number.isSafeInteger(message.message_id) || message.message_id! <= 0) return undefined;
  const kind = message.chat!.type === "private" ? "private" : "group";
  if (kind === "private" && message.from.id !== message.chat!.id) return undefined;
  const original = message.text ?? message.caption ?? "";
  if (typeof original !== "string" || original.length > 16_384) return undefined;
  const botId = Number(account.replace(/^telegram:/, ""));
  const username = botUsername?.toLowerCase();
  const entities = message.entities ?? message.caption_entities ?? [];
  const matches = entities.filter(entity => Number.isSafeInteger(entity.offset) && Number.isSafeInteger(entity.length) && entity.offset >= 0 && entity.length > 0 && entity.offset + entity.length <= original.length)
    .filter(entity => (entity.type === "text_mention" && entity.user?.id === botId) || (entity.type === "mention" && username && original.slice(entity.offset, entity.offset + entity.length).toLowerCase() === `@${username}`));
  let text = original;
  for (const entity of [...matches].sort((a, b) => b.offset - a.offset)) text = text.slice(0, entity.offset) + text.slice(entity.offset + entity.length);
  if (username) text = text.replace(/^\s*(\/[A-Za-z0-9_]+)@([A-Za-z0-9_]+)(?=\s|$)/, (whole, command: string, target: string) => target.toLowerCase() === username ? command : whole);
  text = text.trim();
  const attachments: ChannelAttachment[] = [];
  const add = (file: TelegramFile | undefined, attachmentKind: ChannelAttachment["kind"]) => {
    if (!file?.file_id) return;
    attachments.push({ id: file.file_unique_id ?? file.file_id, kind: attachmentKind,
      ...(file.file_name ? { name: file.file_name } : {}), ...(file.mime_type ? { mediaType: file.mime_type } : attachmentKind === "image" ? { mediaType: "image/jpeg" } : {}),
      ...(file.file_size === undefined ? {} : { size: file.file_size }), source: { platform: "telegram", fileId: file.file_id } });
  };
  add(message.photo?.at(-1), "image"); add(message.document, "file"); add(message.audio ?? message.voice, "audio"); add(message.video ?? message.animation, "video"); add(message.sticker, "unsupported");
  if (!text && !attachments.length) return undefined;
  const time = message.edit_date ?? message.date;
  return { account, eventId: String(update.update_id), sender: String(message.from.id), conversation: String(message.chat!.id), text, kind,
    messageId: String(message.message_id), eventType: update.edited_message ? "edit" : "message", mentioned: matches.length > 0,
    ...(message.message_thread_id === undefined ? {} : { threadId: String(message.message_thread_id) }),
    ...(message.reply_to_message?.message_id === undefined ? {} : { replyTo: String(message.reply_to_message.message_id), replyToBot: message.reply_to_message.from?.id === botId }),
    ...(time === undefined ? {} : { occurredAt: String(time * 1000) }), ...(attachments.length ? { attachments } : {}) };
}

export interface FeishuEvent {
  event_id?: string;
  sender?: { sender_type?: string; sender_id?: { open_id?: string } };
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
