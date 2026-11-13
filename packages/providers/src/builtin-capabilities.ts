import type { ModelCapabilityDeclaration, ModelCapabilityKey } from "@sortedyuan/may/config";
import { omitUndefined } from "@sortedyuan/may/core";
import type { ModelCapabilityFields, ReasoningEffortCapabilities } from "./capabilities.js";
import { known } from "./capability-values.js";
import type { ProviderModelSelection } from "./types.js";

/** @experimental */
export function builtinAdapterCapabilities(adapter: string): ModelCapabilityFields {
  if (adapter === "google-gemini")
    return Object.fromEntries(
      Object.entries({
        "input.text": true,
        "input.image": true,
        "input.audio": true,
        "input.file": true,
        "input.resource": false,
        "input.image.sources": ["url", "base64"],
        "input.audio.sources": ["url", "base64"],
        "input.file.sources": ["url", "base64"],
        "output.text": true,
        "output.image": true,
        "output.audio": true,
        tools: true,
        "serverTools.webSearch": true,
        "structuredOutput.json": true,
        "structuredOutput.jsonSchema": true,
        "structuredOutput.schemaDialects": ["draft-07", "2020-12"],
        contextCompaction: false,
        "reasoning.modes": ["effort", "budget"],
      }).map(([field, value]) => [field, known(value, "adapter")]),
    );
  if (
    ![
      "openai-responses",
      "openai-chat-completions",
      "deepseek-chat",
      "kimi-chat",
      "zhipu-chat",
      "anthropic-messages",
    ].includes(adapter)
  )
    return {};
  const responses = adapter === "openai-responses";
  const anthropic = adapter === "anthropic-messages";
  const openaiChat = adapter === "openai-chat-completions";
  const values: Partial<Record<ModelCapabilityKey, ModelCapabilityDeclaration>> = {
    "input.text": true,
    "input.image": true,
    "input.audio": false,
    "input.file": responses || anthropic,
    "input.resource": false,
    "input.image.sources": responses || anthropic ? ["url", "base64", "file"] : ["url", "base64"],
    "input.file.sources": responses || anthropic ? ["url", "base64", "file"] : false,
    "output.text": true,
    "output.image": responses,
    "output.audio": false,
    tools: true,
    "serverTools.webSearch": responses || anthropic || openaiChat || adapter === "zhipu-chat",
    "structuredOutput.json": responses || openaiChat,
    "structuredOutput.jsonSchema": responses || openaiChat,
    "structuredOutput.schemaDialects": responses || openaiChat ? ["draft-07", "2020-12"] : false,
    contextCompaction: responses,
    "reasoning.modes": anthropic
      ? ["effort", "budget", "adaptive"]
      : responses
        ? ["effort", "summary"]
        : openaiChat
          ? ["effort"]
          : ["effort", "thinking"],
  };
  return Object.fromEntries(Object.entries(values).map(([field, value]) => [field, known(value, "adapter")]));
}
interface CatalogReasoningEffort {
  readonly efforts: readonly string[];
  readonly defaultEffort?: string;
}
const BUILTIN_REASONING_EFFORTS = new Map<string, CatalogReasoningEffort>([
  ...["openai-responses", "openai-chat-completions"].flatMap((adapter) =>
    ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].map(
      (model) =>
        [
          catalogKey(adapter, model),
          { efforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
        ] as const,
    ),
  ),
  ...["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"].map(
    (model) =>
      [catalogKey("deepseek-chat", model), { efforts: ["low", "high", "max"], defaultEffort: "high" }] as const,
  ),
]);
export function builtinReasoningEffort(selection: ProviderModelSelection): ReasoningEffortCapabilities | undefined {
  const entry = BUILTIN_REASONING_EFFORTS.get(catalogKey(selection.adapter, selection.model));
  return entry === undefined
    ? undefined
    : omitUndefined({
        status: "known",
        source: "builtin",
        efforts: [...entry.efforts],
        defaultEffort: entry.defaultEffort,
      });
}
function catalogKey(adapter: string, model: string): string {
  return `${adapter}\u0000${model}`;
}
