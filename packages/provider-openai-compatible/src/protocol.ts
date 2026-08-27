export interface OpenAICompatibleFunctionCall {
  name: string;
  arguments: string;
}

export interface OpenAICompatibleToolCall {
  id: string;
  type: "function";
  function: OpenAICompatibleFunctionCall;
}

export type OpenAICompatibleMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string;
      reasoning_content?: string;
      tool_calls?: OpenAICompatibleToolCall[];
    }
  | {
      role: "tool";
      content: string;
      tool_call_id: string;
    };

export interface OpenAICompatibleToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Readonly<Record<string, unknown>>;
  };
}

export interface OpenAICompatibleToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface OpenAICompatibleChunk {
  choices?: Array<{
    index: number;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: OpenAICompatibleToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
}
