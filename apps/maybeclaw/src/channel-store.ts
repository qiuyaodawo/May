import { replaceJournalFile } from "@may/session/file-store";
import { open, type FileHandle } from "node:fs/promises";
import { digest, validateId } from "./types.js";

export interface ChannelInput {
  account: string;
  eventId: string;
  sender: string;
  conversation: string;
  text: string;
}
export interface InboxRecord {
  kind: "inbox"; id: string; input: ChannelInput; processed: boolean;
  taskId?: string; terminalNotified?: boolean;
}
export interface DeliveryRecord {
  kind: "delivery"; id: string; account: string; sender: string; conversation: string;
  text: string; taskId?: string; status: "pending" | "sending" | "sent" | "unknown" | "suppressed";
}
interface CursorRecord { kind: "cursor"; id: string; offset: number }
export type ChannelRecord = InboxRecord | DeliveryRecord | CursorRecord;

/** Single-writer journal: caller must own host.lock for this instance's entire lifetime. */
export class ChannelStore {
  private records = new Map<string, ChannelRecord>();
  private tail: Promise<void> = Promise.resolve();
  private size = 0;
  private constructor(private file: FileHandle, private readonly path: string) {}
  static async open(path: string): Promise<ChannelStore> {
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
    for (const key of ["account", "eventId", "sender", "conversation", "text"] as const) if (typeof input[key] !== "string" || !input[key] || input[key].length > (key === "text" ? 16_384 : 256)) throw new Error("Invalid channel input");
    if (value.taskId) validateId(value.taskId);
  } else if (value.kind === "delivery") {
    for (const key of ["account", "sender", "conversation", "text"] as const) if (typeof value[key] !== "string" || !value[key] || value[key].length > (key === "text" ? 4096 : 256)) throw new Error("Invalid channel delivery");
    if (!["pending", "sending", "sent", "unknown", "suppressed"].includes(value.status)) throw new Error("Invalid delivery status");
    if (value.taskId) validateId(value.taskId);
  } else throw new Error("Unknown channel record");
}
