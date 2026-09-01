export type JsonSchema = Readonly<Record<string, unknown>>;

export type MediaSource =
  | { type: "url"; url: string }
  | { type: "base64"; mediaType: string; data: string }
  | { type: "file"; fileId: string };

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "json"; value: unknown }
  | {
      type: "image";
      source: MediaSource;
      detail?: "auto" | "low" | "high";
    }
  | { type: "audio"; source: MediaSource }
  | { type: "file"; source: MediaSource; name?: string }
  | {
      /** Provider-neutral reference for custom adapters and resource systems. */
      type: "resource";
      uri: string;
      name?: string;
      mediaType?: string;
    };

export interface SystemMessage {
  role: "system";
  content: ContentPart[];
}

export interface UserMessage {
  role: "user";
  content: ContentPart[];
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ModelState<Data = unknown> {
  /** Adapter-owned, namespaced, and versioned state identifier. */
  type: string;
  /** Opaque continuation data interpreted only by the owning adapter. */
  data: Data;
}

export interface AssistantMessage {
  role: "assistant";
  content: ContentPart[];
  toolCalls?: ToolCall[];
  /** Provider-specific continuation state that May persists but never reads. */
  modelState?: ModelState;
}

export interface ToolMessage {
  role: "tool";
  toolCallId: string;
  name: string;
  content: ContentPart[];
  isError?: boolean;
}

export type Message =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage;

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export function textContent(text: string): ContentPart[] {
  return [{ type: "text", text }];
}

export function reasoningContent(text: string): ContentPart[] {
  return [{ type: "reasoning", text }];
}

export function userMessage(text: string): UserMessage {
  return { role: "user", content: textContent(text) };
}

/** Close a provider tool call when its run is cancelled before execution ends. */
export function toolCancellationMessage(
  call: Readonly<ToolCall>,
  reason?: string,
): ToolMessage {
  return {
    role: "tool",
    toolCallId: call.id,
    name: call.name,
    isError: true,
    content: [{
      type: "json",
      value: {
        name: "RunCancelledError",
        message: reason ?? "Run was cancelled",
        code: "RUN_CANCELLED",
      },
    }],
  };
}
