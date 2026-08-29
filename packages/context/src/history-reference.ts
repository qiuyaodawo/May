import type { ContextSnapshot, Message, SystemMessage } from "@may/core";

import type {
  ContextCompactionOptions,
  ContextCompactionStrategy,
} from "./compaction.js";

export interface HistoryReferenceRequest {
  readonly snapshot: Readonly<ContextSnapshot>;
  readonly signal?: AbortSignal;
}

export type HistoryReferenceProvider = (
  request: HistoryReferenceRequest,
) => string | Promise<string>;

export interface HistoryReferenceOptions {
  readonly reference: string | HistoryReferenceProvider;
  readonly keepRecentTurns?: number;
}

export class HistoryReferenceStrategy implements ContextCompactionStrategy {
  readonly name = "history-reference";

  private readonly reference: string | HistoryReferenceProvider;
  private readonly keepRecentTurns: number;

  constructor(options: HistoryReferenceOptions) {
    if (typeof options.reference === "string" && options.reference.trim() === "") {
      throw new Error("history reference cannot be empty");
    }
    this.reference = options.reference;
    this.keepRecentTurns = positiveInteger(
      options.keepRecentTurns ?? 1,
      "keepRecentTurns",
    );
  }

  async compact(
    snapshot: Readonly<ContextSnapshot>,
    options: ContextCompactionOptions = {},
  ): Promise<readonly Message[]> {
    throwIfAborted(options.signal);
    const userIndexes = snapshot.messages
      .map((message, index) => message.role === "user" ? index : undefined)
      .filter((index): index is number => index !== undefined);
    if (userIndexes.length <= this.keepRecentTurns) return snapshot.messages;

    const boundary = userIndexes[userIndexes.length - this.keepRecentTurns]!;
    if (boundary === 0) return snapshot.messages;
    const reference = (typeof this.reference === "string"
      ? this.reference
      : await this.reference({
        snapshot: {
          ...snapshot,
          messages: [...snapshot.messages],
        },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })).trim();
    throwIfAborted(options.signal);
    if (reference === "") throw new Error("history reference cannot be empty");

    const referenceMessage: SystemMessage = {
      role: "system",
      content: [{ type: "text", text: reference }],
    };
    const compacted: Message[] = [
      referenceMessage,
      ...snapshot.messages.slice(boundary),
    ];
    return serializedBytes(compacted) < serializedBytes(snapshot.messages)
      ? compacted
      : snapshot.messages;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function serializedBytes(messages: readonly Message[]): number {
  return new TextEncoder().encode(JSON.stringify(messages)).byteLength;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const error = new Error(
    typeof signal.reason === "string"
      ? signal.reason
      : "History-reference compaction cancelled",
  );
  error.name = "AbortError";
  throw error;
}
