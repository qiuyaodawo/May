import type {
  AssistantMessage,
  ModelEvent,
  ToolCall,
  Usage,
} from "@may/core";
import {
  AnthropicFinishReasonError,
  AnthropicProtocolError,
  AnthropicStreamError,
} from "./errors.js";
import {
  ANTHROPIC_MODEL_STATE_TYPE,
  type AnthropicAssistantContentBlock,
  type AnthropicRedactedThinkingBlock,
  type AnthropicTextBlock,
  type AnthropicThinkingBlock,
  type AnthropicToolUseBlock,
} from "./protocol.js";
import { readAnthropicSseData } from "./sse.js";

interface PendingBase {
  stopped: boolean;
}

interface PendingText extends PendingBase {
  kind: "text";
  block: AnthropicTextBlock;
}

interface PendingThinking extends PendingBase {
  kind: "thinking";
  block: AnthropicThinkingBlock;
}

interface PendingRedactedThinking extends PendingBase {
  kind: "redacted_thinking";
  block: AnthropicRedactedThinkingBlock;
}

interface PendingToolUse extends PendingBase {
  kind: "tool_use";
  block: AnthropicToolUseBlock;
  partialJson: string;
}

type PendingBlock =
  | PendingText
  | PendingThinking
  | PendingRedactedThinking
  | PendingToolUse;

export async function* streamAnthropicResponse(
  response: Response,
  signal: AbortSignal,
): AsyncIterable<ModelEvent> {
  const blocks = new Map<number, PendingBlock>();
  let messageId: string | undefined;
  let sawMessageStart = false;
  let sawMessageStop = false;
  let stopReason: string | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  for await (const data of readAnthropicSseData(response, signal)) {
    const event = parseEvent(data);

    if (event.type === "ping") continue;
    if (event.type === "error") throw createStreamError(event);

    if (event.type === "message_start") {
      if (sawMessageStart) {
        throw new AnthropicProtocolError(
          "Anthropic emitted more than one message_start event",
        );
      }
      const message = requireRecord(event.message, "message_start.message");
      messageId = requireString(message.id, "message_start.message.id");
      const usage = optionalRecord(message.usage);
      inputTokens = optionalTokenCount(usage?.input_tokens);
      outputTokens = optionalTokenCount(usage?.output_tokens);
      sawMessageStart = true;
      continue;
    }

    if (event.type === "content_block_start") {
      requireActiveMessage(sawMessageStart, sawMessageStop);
      const index = requireIndex(event.index);
      if (blocks.has(index)) {
        throw new AnthropicProtocolError(
          `Anthropic started content block ${index} more than once`,
        );
      }
      blocks.set(index, createPendingBlock(event.content_block, index));
      continue;
    }

    if (event.type === "content_block_delta") {
      requireActiveMessage(sawMessageStart, sawMessageStop);
      const index = requireIndex(event.index);
      const block = requirePendingBlock(blocks, index);
      const delta = requireRecord(event.delta, `content block ${index} delta`);
      const deltaType = requireString(
        delta.type,
        `content block ${index} delta.type`,
      );

      if (deltaType === "text_delta") {
        if (block.kind !== "text") throw mismatchedDelta(index, deltaType);
        const text = requireString(delta.text, `content block ${index} text`);
        block.block.text += text;
        if (text !== "") yield { type: "text.delta", delta: text };
        continue;
      }

      if (deltaType === "thinking_delta") {
        if (block.kind !== "thinking") throw mismatchedDelta(index, deltaType);
        const thinking = requireString(
          delta.thinking,
          `content block ${index} thinking`,
        );
        block.block.thinking += thinking;
        if (thinking !== "") {
          yield { type: "reasoning.delta", delta: thinking };
        }
        continue;
      }

      if (deltaType === "signature_delta") {
        if (block.kind !== "thinking") throw mismatchedDelta(index, deltaType);
        block.block.signature += requireString(
          delta.signature,
          `content block ${index} signature`,
        );
        continue;
      }

      if (deltaType === "input_json_delta") {
        if (block.kind !== "tool_use") throw mismatchedDelta(index, deltaType);
        block.partialJson += requireString(
          delta.partial_json,
          `content block ${index} partial_json`,
        );
      }
      // Anthropic may add new delta types; unknown ones are ignored.
      continue;
    }

    if (event.type === "content_block_stop") {
      requireActiveMessage(sawMessageStart, sawMessageStop);
      const index = requireIndex(event.index);
      const block = requirePendingBlock(blocks, index);
      if (block.kind === "tool_use" && block.partialJson.trim() !== "") {
        block.block.input = parseToolInput(block.partialJson, index);
      }
      block.stopped = true;
      continue;
    }

    if (event.type === "message_delta") {
      requireActiveMessage(sawMessageStart, sawMessageStop);
      const delta = requireRecord(event.delta, "message_delta.delta");
      if (delta.stop_reason !== undefined && delta.stop_reason !== null) {
        stopReason = requireString(
          delta.stop_reason,
          "message_delta.delta.stop_reason",
        );
      }
      const usage = optionalRecord(event.usage);
      inputTokens = optionalTokenCount(usage?.input_tokens) ?? inputTokens;
      outputTokens = optionalTokenCount(usage?.output_tokens) ?? outputTokens;
      continue;
    }

    if (event.type === "message_stop") {
      requireActiveMessage(sawMessageStart, sawMessageStop);
      sawMessageStop = true;
    }
    // Unknown event types are ignored for forward compatibility.
  }

  if (!sawMessageStart || messageId === undefined) {
    throw new AnthropicProtocolError(
      "Anthropic stream ended without a message_start event",
    );
  }
  if (!sawMessageStop) {
    throw new AnthropicProtocolError(
      "Anthropic stream ended without a message_stop event",
    );
  }
  if (stopReason === undefined) {
    throw new AnthropicProtocolError(
      "Anthropic stream ended without a stop_reason",
    );
  }
  if (stopReason !== "end_turn" && stopReason !== "tool_use") {
    throw new AnthropicFinishReasonError(stopReason);
  }

  const content = [...blocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, block]) => {
      if (!block.stopped) {
        throw new AnthropicProtocolError(
          `Anthropic content block ${index} did not stop`,
        );
      }
      return block.block;
    });
  const message = toAssistantMessage(messageId, content);
  const calls = message.toolCalls ?? [];
  if (stopReason === "tool_use" && calls.length === 0) {
    throw new AnthropicProtocolError(
      "Anthropic stopped for tool_use but emitted no tool calls",
    );
  }
  if (stopReason !== "tool_use" && calls.length > 0) {
    throw new AnthropicProtocolError(
      `Anthropic emitted tool calls with stop reason "${stopReason}"`,
    );
  }

  const completed: Extract<ModelEvent, { type: "response.completed" }> = {
    type: "response.completed",
    message,
  };
  const usage = createUsage(inputTokens, outputTokens);
  if (usage !== undefined) completed.usage = usage;
  yield completed;
}

function parseEvent(data: string): Record<string, unknown> {
  try {
    const event: unknown = JSON.parse(data);
    const record = requireRecord(event, "stream event");
    requireString(record.type, "stream event.type");
    return record;
  } catch (error) {
    if (error instanceof AnthropicProtocolError) throw error;
    throw new AnthropicProtocolError(
      "Anthropic emitted invalid SSE JSON",
      { cause: error },
    );
  }
}

function createPendingBlock(value: unknown, index: number): PendingBlock {
  const block = requireRecord(value, `content block ${index}`);
  const type = requireString(block.type, `content block ${index}.type`);

  if (type === "text") {
    return {
      kind: "text",
      stopped: false,
      block: {
        type,
        text: requireString(block.text, `content block ${index}.text`),
      },
    };
  }
  if (type === "thinking") {
    return {
      kind: "thinking",
      stopped: false,
      block: {
        type,
        thinking: requireString(
          block.thinking,
          `content block ${index}.thinking`,
        ),
        signature: requireString(
          block.signature,
          `content block ${index}.signature`,
        ),
      },
    };
  }
  if (type === "redacted_thinking") {
    return {
      kind: "redacted_thinking",
      stopped: false,
      block: {
        type,
        data: requireString(block.data, `content block ${index}.data`),
      },
    };
  }
  if (type === "tool_use") {
    return {
      kind: "tool_use",
      stopped: false,
      partialJson: "",
      block: {
        type,
        id: requireString(block.id, `content block ${index}.id`),
        name: requireString(block.name, `content block ${index}.name`),
        input: requireObject(block.input, `content block ${index}.input`),
      },
    };
  }

  throw new AnthropicProtocolError(
    `Anthropic emitted unsupported content block type "${type}"`,
  );
}

function toAssistantMessage(
  messageId: string,
  blocks: AnthropicAssistantContentBlock[],
): AssistantMessage {
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    modelState: {
      type: ANTHROPIC_MODEL_STATE_TYPE,
      data: { messageId, content: blocks },
    },
  };
  const calls: ToolCall[] = [];

  for (const block of blocks) {
    if (block.type === "thinking") {
      message.content.push({ type: "reasoning", text: block.thinking });
    } else if (block.type === "text") {
      if (block.text !== "") {
        message.content.push({ type: "text", text: block.text });
      }
    } else if (block.type === "tool_use") {
      calls.push({ id: block.id, name: block.name, input: block.input });
    }
  }

  if (calls.length > 0) message.toolCalls = calls;
  return message;
}

function createStreamError(event: Record<string, unknown>): AnthropicStreamError {
  const error = optionalRecord(event.error);
  const providerType = optionalString(error?.type);
  const requestId = optionalString(event.request_id);
  const message = optionalString(error?.message) ?? "Anthropic stream failed";
  const options: ConstructorParameters<typeof AnthropicStreamError>[0] = {
    message,
  };
  if (providerType !== undefined) options.providerType = providerType;
  if (requestId !== undefined) options.requestId = requestId;
  return new AnthropicStreamError(options);
}

function parseToolInput(input: string, index: number): Record<string, unknown> {
  try {
    return requireObject(
      JSON.parse(input),
      `content block ${index} tool input`,
    );
  } catch (error) {
    if (error instanceof AnthropicProtocolError) throw error;
    throw new AnthropicProtocolError(
      `Anthropic emitted invalid tool input JSON at content block ${index}`,
      { cause: error },
    );
  }
}

function requireActiveMessage(started: boolean, stopped: boolean): void {
  if (!started) {
    throw new AnthropicProtocolError(
      "Anthropic emitted content before message_start",
    );
  }
  if (stopped) {
    throw new AnthropicProtocolError(
      "Anthropic emitted content after message_stop",
    );
  }
}

function requirePendingBlock(
  blocks: Map<number, PendingBlock>,
  index: number,
): PendingBlock {
  const block = blocks.get(index);
  if (!block) {
    throw new AnthropicProtocolError(
      `Anthropic referenced unknown content block ${index}`,
    );
  }
  if (block.stopped) {
    throw new AnthropicProtocolError(
      `Anthropic emitted a delta after content block ${index} stopped`,
    );
  }
  return block;
}

function mismatchedDelta(index: number, deltaType: string): AnthropicProtocolError {
  return new AnthropicProtocolError(
    `Anthropic emitted ${deltaType} for incompatible content block ${index}`,
  );
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AnthropicProtocolError(`Anthropic ${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  return requireRecord(value, name);
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new AnthropicProtocolError(`Anthropic ${name} must be a string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requireIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AnthropicProtocolError(
      "Anthropic content block index must be a non-negative safe integer",
    );
  }
  return value as number;
}

function optionalTokenCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : undefined;
}

function createUsage(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): Usage | undefined {
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  const usage: Usage = {};
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (inputTokens !== undefined && outputTokens !== undefined) {
    usage.totalTokens = inputTokens + outputTokens;
  }
  return usage;
}
