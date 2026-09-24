import { replaceJournalFile } from "@may/session/file-store";
import { access, open, readFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { digest, validateId } from "./types.js";

export interface ChannelInput {
  account: string;
  eventId: string;
  sender: string;
  conversation: string;
  text: string;
  kind?: "private" | "group";
  threadId?: string;
  messageId?: string;
  replyTo?: string;
  replyToBot?: boolean;
  mentioned?: boolean;
  eventType?: "message" | "edit" | "delete" | "member-left" | "member-joined";
  occurredAt?: string;
  attachments?: ChannelAttachment[];
}
export interface ChannelAttachment {
  id: string;
  kind: "image" | "file" | "audio" | "video" | "unsupported";
  name?: string;
  mediaType?: string;
  size?: number;
  source: { platform: "telegram" | "feishu"; fileId: string; messageId?: string };
}
export interface ChannelDeliveryReceipt { messageId: string; threadId?: string }
export interface InboxRecord {
  kind: "inbox"; id: string; input: ChannelInput; processed: boolean;
  taskId?: string; terminalNotified?: boolean;
}
export interface DeliveryRecord {
  imageId?: string;
  after?: string;
  kind: "delivery"; id: string; account: string; sender: string; conversation: string;
  text: string; taskId?: string; status: "pending" | "sending" | "sent" | "unknown" | "suppressed";
  threadId?: string;
  replyTo?: string;
  messageId?: string;
  conversationKind?: "private" | "group";
}
interface CursorRecord { kind: "cursor"; id: string; offset: number }
export type ChannelRecord = InboxRecord | DeliveryRecord | CursorRecord;

/** Single-writer journal: caller must own host.lock for this instance's entire lifetime. */
export class ChannelStore {
  private records = new Map<string, ChannelRecord>();
  private tail: Promise<void> = Promise.resolve();
  private size = 0;
  private constructor(private file: FileHandle, private readonly path: string) {}
  static async inspect(path: string): Promise<ChannelRecord[]> {
    const bytes = await readFile(path);
    if (bytes.length > 32 * 1024 * 1024) throw new Error("Channel journal exceeds size limit");
    const records = new Map<string, ChannelRecord>();
    const end = bytes.lastIndexOf(10) + 1;
    for (const line of bytes.subarray(0, end).toString("utf8").split("\n").filter(Boolean)) {
      const record = JSON.parse(line) as ChannelRecord;
      validateRecord(record);
      records.set(record.id, record);
    }
    return [...records.values()];
  }
  static async open(path: string): Promise<ChannelStore> {
    if (basename(path) === "channels.jsonl") {
      for (const marker of ["gateway.format.json", "gateway.sqlite"]) {
        const migrated = await access(join(dirname(path), marker)).then(() => true, error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        });
        if (migrated) throw new Error("Legacy channel storage is read-only after Gateway migration");
      }
    }
    const file = await open(path, "a+", 0o600);
    const store = new ChannelStore(file, path);
    try {
      if ((await file.stat()).size > 32 * 1024 * 1024) throw new Error("Channel journal exceeds size limit");
      const bytes = await file.readFile();
      if (bytes.length > 32 * 1024 * 1024) throw new Error("Channel journal is full; archive stopped host data before continuing");
      const end = bytes.lastIndexOf(10) + 1;
      for (const line of bytes.subarray(0, end).toString("utf8").split("\n").filter(Boolean)) {
        const record = JSON.parse(line) as ChannelRecord;
        validateRecord(record);
        store.records.set(record.id, record);
      }
      if (end !== bytes.length) {
        const repair = await open(path, "r+");
        try { await repair.truncate(end); await repair.sync(); } finally { await repair.close(); }
      }
      store.size = end;
      // A crash after send intent cannot establish whether the platform received it.
      for (const record of store.values()) if (record.kind === "delivery" && record.status === "sending") await store.put({ ...record, status: "unknown" });
      return store;
    } catch (error) { await file.close(); throw error; }
  }
  get(id: string): ChannelRecord | undefined { const value = this.records.get(id); return value && structuredClone(value); }
  values(): ChannelRecord[] { return [...this.records.values()].map((v) => structuredClone(v)); }
  put(record: ChannelRecord): Promise<void> {
    const copy = structuredClone(record);
    const operation = this.tail.then(async () => {
      validateRecord(copy);
      const line = JSON.stringify(copy) + "\n";
      const length = Buffer.byteLength(line);
      if (this.size + length > 32 * 1024 * 1024) {
        const records = new Map(this.records); records.set(copy.id, copy);
        const checkpoint = [...records.values()].map((record) => JSON.stringify(record) + "\n").join("");
        if (Buffer.byteLength(checkpoint) > 32 * 1024 * 1024) throw new Error("Channel state limit reached; archive stopped host data");
        const previous = this.file;
        await previous.close();
        this.file = await replaceJournalFile(this.path, checkpoint);
        this.size = Buffer.byteLength(checkpoint);
      } else { await this.file.writeFile(line); await this.file.sync(); this.size += length; }
      this.records.set(copy.id, copy);
    });
    // Poison after an uncertain write: no later ack or send can pass it.
    this.tail = operation;
    return operation;
  }
  remove(ids: readonly string[]): Promise<void> {
    for (const id of ids) validateId(id);
    const operation = this.tail.then(async () => {
      const remaining = new Map(this.records);
      for (const id of ids) remaining.delete(id);
      if (remaining.size === this.records.size) return;
      const checkpoint = [...remaining.values()].map(record => JSON.stringify(record) + "\n").join("");
      await this.file.close();
      this.file = await replaceJournalFile(this.path, checkpoint);
      this.size = Buffer.byteLength(checkpoint);
      this.records = remaining;
    });
    this.tail = operation;
    return operation;
  }
  async close(): Promise<void> { try { await this.tail; } finally { await this.file.close(); } }
}
export function inboxId(input: ChannelInput): string { return digest({ account: input.account, eventId: input.eventId }); }
export function cursorId(account: string): string { return digest({ account, type: "cursor" }); }
function validateRecord(value: ChannelRecord): void {
  if (!value || typeof value !== "object") throw new Error("Invalid channel record");
  validateId(value.id);
  if (value.kind === "cursor") {
    if (!Number.isSafeInteger(value.offset) || value.offset < 0) throw new Error("Invalid channel cursor");
  } else if (value.kind === "inbox") {
    const input = value.input;
    if (!input || inboxId(input) !== value.id || typeof value.processed !== "boolean") throw new Error("Invalid inbox record");
    validateChannelInput(input);
    if (value.taskId) validateId(value.taskId);
  } else if (value.kind === "delivery") {
    if (value.imageId) { validateId(value.imageId); if (!value.taskId) throw new Error("Image delivery requires a task"); }
    if (value.after) validateId(value.after);
    for (const key of ["account", "sender", "conversation", "text"] as const) if (typeof value[key] !== "string" || !value[key] || value[key].length > (key === "text" ? 4096 : 256)) throw new Error("Invalid channel delivery");
    if (!["pending", "sending", "sent", "unknown", "suppressed"].includes(value.status)) throw new Error("Invalid delivery status");
    for (const key of ["threadId", "replyTo", "messageId"] as const) optionalString(value[key], key);
    if (value.conversationKind !== undefined && !["private", "group"].includes(value.conversationKind)) throw new Error("Invalid delivery conversation kind");
    if (value.taskId) validateId(value.taskId);
  } else throw new Error("Unknown channel record");
}

export function validateChannelInput(input: ChannelInput): void {
  for (const key of ["account", "eventId", "sender", "conversation"] as const) {
    if (typeof input[key] !== "string" || !input[key] || input[key].length > 256) throw new Error("Invalid channel input");
  }
  const membership = input.eventType === "member-left" || input.eventType === "member-joined";
  if (typeof input.text !== "string" || input.text.length > 16_384 || (!input.text.trim() && input.eventType !== "delete" && !membership && !input.attachments?.length)) throw new Error("Invalid channel input text");
  if (input.kind !== undefined && !["private", "group"].includes(input.kind)) throw new Error("Invalid channel conversation kind");
  if (input.eventType !== undefined && !["message", "edit", "delete", "member-left", "member-joined"].includes(input.eventType)) throw new Error("Invalid channel event type");
  for (const key of ["threadId", "messageId", "replyTo", "occurredAt"] as const) optionalString(input[key], key);
  for (const key of ["replyToBot", "mentioned"] as const) if (input[key] !== undefined && typeof input[key] !== "boolean") throw new Error(`Invalid ${key}`);
  if ((input.eventType === "edit" || input.eventType === "delete") && !input.messageId) throw new Error("Message changes require a message ID");
  if (membership && (input.kind !== "group" || input.threadId || input.attachments?.length)) throw new Error("Member changes require a group entrance without attachments");
  if (input.attachments !== undefined) {
    if (!Array.isArray(input.attachments) || input.attachments.length > 20) throw new Error("Invalid channel attachments");
    for (const attachment of input.attachments) {
      if (!attachment || !["image", "file", "audio", "video", "unsupported"].includes(attachment.kind)) throw new Error("Invalid channel attachment");
      if (typeof attachment.id !== "string" || !attachment.id || attachment.id.length > 256) throw new Error("Invalid attachment ID");
      optionalString(attachment.name, "attachment name", 1024);
      optionalString(attachment.mediaType, "attachment media type");
      if (attachment.size !== undefined && (!Number.isSafeInteger(attachment.size) || attachment.size < 0)) throw new Error("Invalid attachment size");
      if (!attachment.source || !["telegram", "feishu"].includes(attachment.source.platform) || typeof attachment.source.fileId !== "string" || !attachment.source.fileId || attachment.source.fileId.length > 256) throw new Error("Invalid attachment source");
      optionalString(attachment.source.messageId, "attachment message ID");
    }
  }
}
function optionalString(value: unknown, label: string, limit = 256): void {
  if (value !== undefined && (typeof value !== "string" || !value || value.length > limit)) throw new Error(`Invalid ${label}`);
}
