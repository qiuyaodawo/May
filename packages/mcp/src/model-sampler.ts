import type { AssistantMessage, ContentPart, Message, Model, ToolCall } from "@may/core";
import { randomUUID } from "node:crypto";
import type { CreateMessageRequestParams, CreateMessageResult, CreateMessageResultWithTools, SamplingMessageContentBlock, SamplingContent } from "@modelcontextprotocol/client";
import { mcpToolResultContent } from "./content.js";
import { hostBounded, hostFailure, type McpHostRequestContext, type McpSamplingService } from "./host-services.js";

export interface McpSamplingModel {
  readonly model: Model;
  readonly name: string;
}

/** Isolated one-shot model bridge. Produces remote tool proposals but NEVER executes tools. */
export function createMcpModelSampler(create: (maxTokens: number, context: McpHostRequestContext) => McpSamplingModel | Promise<McpSamplingModel>): McpSamplingService {
  return { supportsTools: true, async createMessage(params, context) {
    const selection = await create(params.maxTokens, context);
    const maximum = selection.model.limits?.maxOutputTokens;
    if (!Number.isSafeInteger(maximum) || maximum! < 1 || maximum! > params.maxTokens) throw hostFailure(context.serverId, "sampling model must declare and enforce the requested output-token bound");
    const messages = samplingMessages(params, context.serverId);
    const tools = params.toolChoice?.mode === "none" ? [] : (params.tools ?? []).map((tool) => ({
      name: tool.name, description: tool.description ?? "", inputSchema: structuredClone(tool.inputSchema),
    }));
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    let completed: AssistantMessage | undefined;
    let streamedBytes = 0;
    let outputTokens = 0;
    try {
      for await (const event of selection.model.stream({ messages, tools }, { signal,
        ...(context.owner.runId === undefined ? {} : { runId: context.owner.runId }), modelCallId: `mcp-sampling:${randomUUID()}`,
      })) {
        signal.throwIfAborted();
        if (event.type === "text.delta" || event.type === "reasoning.delta") {
          streamedBytes += Buffer.byteLength(event.delta);
          if (streamedBytes > 48 * 1024) throw hostFailure(context.serverId, "sampling output stream exceeds byte budget");
        }
        if (event.type === "retrying") throw hostFailure(context.serverId, "sampling adapter must not retry provider requests implicitly");
        if (event.type === "response.completed") {
          if (completed !== undefined) throw hostFailure(context.serverId, "duplicate sampling completion");
          hostBounded(event.message, context.serverId, 48 * 1024);
          if ((event.usage?.outputTokens ?? 0) > params.maxTokens) throw hostFailure(context.serverId, "provider exceeded sampling token budget");
          outputTokens = event.usage?.outputTokens ?? 0;
          completed = event.message;
        }
      }
      signal.throwIfAborted();
      if (completed === undefined || completed.role !== "assistant") throw hostFailure(context.serverId, "sampling model did not complete");
      const calls = completed.toolCalls ?? [];
      if (calls.length > 32 || calls.some((call) => !tools.some((tool) => tool.name === call.name)) || new Set(calls.map((call) => call.id)).size !== calls.length) throw hostFailure(context.serverId, "sampling proposed invalid or undeclared tools");
      if (params.toolChoice?.mode === "required" && calls.length === 0) throw hostFailure(context.serverId, "sampling did not satisfy required tool choice");
      const content = completed.content.filter((part) => part.type !== "reasoning").map((part) => responsePart(part, context.serverId));
      const toolContent = calls.map((call) => ({ type: "tool_use" as const, id: call.id, name: call.name, input: call.input as Record<string, unknown> }));
      const stopReason = calls.length ? "toolUse" : outputTokens >= maximum! ? "maxTokens" : "endTurn";
      if (params.tools !== undefined) return { role: "assistant", model: selection.name, stopReason, content: [...content, ...toolContent] } satisfies CreateMessageResultWithTools;
      if (content.length === 0) content.push({ type: "text", text: "" });
      // Base sampling permits one block. Join text blocks; never silently drop binary.
      if (content.every((part) => part.type === "text")) return { role: "assistant", model: selection.name, stopReason,
        content: { type: "text", text: content.map((part) => (part as { text: string }).text).join("\n") } } satisfies CreateMessageResult;
      if (content.length !== 1) throw hostFailure(context.serverId, "base sampling cannot return mixed output blocks");
      return { role: "assistant", model: selection.name, stopReason, content: content[0]! } satisfies CreateMessageResult;
    } finally { controller.abort("Sampling operation finished"); }
  } };
}

function samplingMessages(params: CreateMessageRequestParams, serverId: string): Message[] {
  const messages: Message[] = [];
  // This system prompt belongs ONLY to the isolated, user-reviewed sampler.
  if (params.systemPrompt !== undefined) messages.push({ role: "system", content: [{ type: "text", text: params.systemPrompt }] });
  const calls = new Map<string, string>();
  const seen = new Set<string>();
  for (const message of params.messages) {
    const content: ContentPart[] = [];
    const toolCalls: ToolCall[] = [];
    const results: Message[] = [];
    for (const part of Array.isArray(message.content) ? message.content : [message.content]) {
      if (part.type === "tool_use") {
        if (message.role !== "assistant" || seen.has(part.id)) throw hostFailure(serverId, "invalid sampling tool-use history");
        seen.add(part.id); calls.set(part.id, part.name);
        toolCalls.push({ id: part.id, name: part.name, input: structuredClone(part.input) });
      } else if (part.type === "tool_result") {
        const name = calls.get(part.toolUseId);
        if (message.role !== "user" || name === undefined) throw hostFailure(serverId, "sampling tool result has no matching call");
        calls.delete(part.toolUseId);
        results.push({ role: "tool", name, toolCallId: part.toolUseId,
          content: mcpToolResultContent(serverId, name, part).slice(1), ...(part.isError === undefined ? {} : { isError: part.isError }),
        });
      } else content.push(...requestPart(part, serverId));
    }
    messages.push(...results);
    if (content.length || toolCalls.length || results.length === 0) {
      if (message.role === "assistant") messages.push({ role: "assistant", content, ...(toolCalls.length ? { toolCalls } : {}) });
      else messages.push({ role: "user", content });
    }
  }
  if (calls.size) throw hostFailure(serverId, "sampling history contains unresolved tool calls");
  return messages;
}

function requestPart(part: Exclude<SamplingMessageContentBlock, { type: "tool_use" | "tool_result" }>, serverId: string): ContentPart[] {
  return mcpToolResultContent(serverId, "sampling", { content: [part] }).slice(1);
}

function responsePart(part: ContentPart, serverId: string): SamplingContent {
  if (part.type === "text") return { type: "text", text: part.text };
  if (part.type === "json") return { type: "text", text: JSON.stringify(part.value) };
  if ((part.type === "image" || part.type === "audio") && part.source.type === "base64") {
    const native = { type: part.type, mimeType: part.source.mediaType, data: part.source.data };
    mcpToolResultContent(serverId, "sampling", { content: [native] });
    return native;
  }
  throw hostFailure(serverId, "sampling output content is unsupported; URLs/files are never fetched automatically");
}
