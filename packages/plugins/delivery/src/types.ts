import type { ImageData, MediaCapabilities } from "@may/media";
import type { Disposer } from "@may/plugin";
import type { ChannelStore, ChannelInput, ChannelAttachment, ChannelDeliveryReceipt, DeliveryRecord } from "./store.js";

export type GroupTrigger = "explicit" | "all";
export interface EntranceTrigger { conversation: string; threadId?: string; trigger: GroupTrigger }
export interface ChannelAccessSettings { allowUsers: readonly string[]; allowGroups?: readonly string[]; groupTrigger?: GroupTrigger; entranceTriggers?: readonly EntranceTrigger[] }
export interface ChannelCapabilities {
  groups: boolean; threads: boolean; nativeReplies: boolean; messageEdits: boolean; messageDeletes: boolean;
  maxTextLength: number; maxAttachmentBytes: number;
  inputAttachments: readonly ChannelAttachment["kind"][]; outputAttachments: readonly ChannelAttachment["kind"][];
}
export interface ChannelAttachmentData { data: Uint8Array; name?: string; mediaType?: string }
export type ChannelState = Pick<ChannelStore, "get" | "put" | "values">;
export interface ChannelAdapter {
  readonly media?: MediaCapabilities;
  readonly name: "telegram" | "feishu";
  readonly account: string;
  readonly allowUsers: readonly string[];
  readonly allowGroups?: readonly string[];
  readonly capabilities?: ChannelCapabilities;
  accepts?(input: Pick<ChannelInput, "sender" | "conversation" | "kind">): boolean;
  triggerFor?(input: Pick<ChannelInput, "conversation" | "threadId">): GroupTrigger;
  status(): string;
  run(receive: (input: ChannelInput) => Promise<void>, store: ChannelState, signal: AbortSignal): Promise<void>;
  send(delivery: DeliveryRecord, signal: AbortSignal, image?: ImageData): Promise<ChannelDeliveryReceipt | void>;
  readAttachment?(input: ChannelInput, attachment: ChannelAttachment, signal: AbortSignal): Promise<ChannelAttachmentData>;
}
export interface ChannelIngress {
  readonly store: ChannelState;
  readonly ready?: Promise<void>;
  receive(input: ChannelInput): Promise<void>;
  onError?(account: string, error: unknown): void | Promise<void>;
}
export interface ChannelRegistry {
  register(adapter: ChannelAdapter): Disposer;
  get(account: string): ChannelAdapter | undefined;
  list(): readonly ChannelAdapter[];
  errors(): ReadonlyMap<string, unknown>;
}
export interface DeliveryAttemptOptions {
  readonly signal: AbortSignal;
  readonly image?: ImageData;
  commit(status: "sending" | "sent" | "unknown", receipt?: ChannelDeliveryReceipt): void | Promise<void>;
}
export interface DeliveryService {
  attempt(adapter: ChannelAdapter, delivery: DeliveryRecord, options: DeliveryAttemptOptions): Promise<ChannelDeliveryReceipt | void>;
}
