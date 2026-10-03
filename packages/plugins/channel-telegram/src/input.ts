import type { ChannelAttachment, ChannelInput } from "@may/plugin-delivery";

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
  const botId = Number(account.replace(/^telegram:/, "")), username = botUsername?.toLowerCase();
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
