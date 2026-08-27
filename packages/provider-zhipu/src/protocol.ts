export interface ZhipuFunctionCall {
  name: string;
  arguments: string;
}

export interface ZhipuToolCall {
  id: string;
  type: "function";
  function: ZhipuFunctionCall;
}

export type ZhipuMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string;
      reasoning_content?: string;
      tool_calls?: ZhipuToolCall[];
    }
  | {
      role: "tool";
      content: string;
      tool_call_id: string;
    };

export interface ZhipuToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Readonly<Record<string, unknown>>;
  };
}

export interface ZhipuChatRequest {
  model: string;
  messages: ZhipuMessage[];
  stream: true;
  thinking: {
    type: "enabled" | "disabled";
    clear_thinking?: boolean;
  };
  reasoning_effort?:
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max";
  max_tokens?: number;
  tools?: ZhipuToolDefinition[];
  tool_stream?: true;
}

export interface ZhipuToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface ZhipuChunk {
  choices?: Array<{
    index: number;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: ZhipuToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
}
