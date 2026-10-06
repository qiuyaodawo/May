export interface OpenAICompatibleFunctionCall {
  name: string;
  arguments: string;
}

export interface OpenAICompatibleToolCall {
  id: string;
  type: "function";
  function: OpenAICompatibleFunctionCall;
}

export type OpenAICompatibleUserContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string; detail?: string } }
    >;

export type OpenAICompatibleMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: OpenAICompatibleUserContent }
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
      name?: string;
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

/** 服务端在 HTTP 200 流中返回的顶层错误，字段内容按各 provider 实现而不同。 */
export interface OpenAICompatibleStreamError {
  message?: string | null;
  type?: string | null;
  code?: string | number | null;
}

export interface OpenAICompatibleChunk {
  /** 顶层错误事件；一旦出现，本次流立即失败。 */
  error?: OpenAICompatibleStreamError | string | number | boolean | null;
  choices?: Array<{
    index: number;
    delta?: {
      content?: string | null;
      refusal?: string | null;
      reasoning_content?: string | null;
      tool_calls?: OpenAICompatibleToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number; audio_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number; audio_tokens?: number };
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  } | null;
}
