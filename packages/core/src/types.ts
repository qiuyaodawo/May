export type JsonSchema = Readonly<Record<string, unknown>>;

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "json"; value: unknown };

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
