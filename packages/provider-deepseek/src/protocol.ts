export interface DeepSeekFunctionCall {
  name: string;
  arguments: string;
}

export interface DeepSeekToolCall {
  id: string;
  type: "function";
  function: DeepSeekFunctionCall;
}

export type DeepSeekMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string;
      reasoning_content?: string;
      tool_calls?: DeepSeekToolCall[];
    }
  | {
      role: "tool";
      content: string;
      tool_call_id: string;
    };

export interface DeepSeekToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Readonly<Record<string, unknown>>;
  };
}

export interface DeepSeekChatRequest {
  model: string;
  messages: DeepSeekMessage[];
  stream: true;
  stream_options: { include_usage: true };
  tools?: DeepSeekToolDefinition[];
  thinking?: { type: "enabled" | "disabled" };
  reasoning_effort?: "low" | "high" | "xhigh" | "max";
}

export interface DeepSeekToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface DeepSeekChunk {
  choices?: Array<{
    index: number;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: DeepSeekToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
}
