import type { MayConfig } from "@sortedyuan/may/config";
import type { Tool } from "@sortedyuan/may/core";
import { createDeepSeekSearchBackend, createZhipuSearchBackend, createWebSearchTool } from "@sortedyuan/coding-tools";
import { createKimiFormulaTools } from "@sortedyuan/providers";
import type { MaybeCodeWebSearchSettings } from "./settings.js";
import { MaybeCodeConfigError } from "./errors.js";

export async function configuredSearchTools(
  config: MayConfig,
  settings: false | MaybeCodeWebSearchSettings | undefined,
): Promise<readonly Tool[]> {
  if (!settings || !settings.hostTool) return [];
  const host = settings.hostTool;
  const provider = config.providers[host.provider];
  if (!provider) throw new MaybeCodeConfigError(`Unknown search provider "${host.provider}"`);
  const apiKey = provider.apiKey ?? (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined);
  if (!apiKey) throw new MaybeCodeConfigError(`Search provider "${host.provider}" requires an API key`);
  const options = { apiKey, ...(provider.baseURL === undefined ? {} : { baseURL: provider.baseURL }) };
  if (host.backend === "kimi-formula") return createKimiFormulaTools({ ...options, uri: "moonshot/web-search:latest" });
  if (host.backend === "zhipu" && !host.searchEngine)
    throw new MaybeCodeConfigError("Zhipu search requires searchEngine");
  const backend =
    host.backend === "deepseek"
      ? createDeepSeekSearchBackend(options)
      : createZhipuSearchBackend({ ...options, searchEngine: host.searchEngine! });
  return [
    createWebSearchTool({ backend, ...(settings.maxResults === undefined ? {} : { maxResults: settings.maxResults }) }),
  ];
}

export function searchStatus(
  settings: false | MaybeCodeWebSearchSettings | undefined,
  adapter: string,
  options: Readonly<Record<string, unknown>>,
  model?: string,
): string {
  if (settings === false) return "Search disabled";
  if (adapter === "openai-chat-completions" && model === "gpt-5-search-api")
    return "Server search enabled for every reply";
  if (options.webSearch !== undefined && options.webSearch !== false) {
    const search = options.webSearch as { version?: string; allowedCallers?: readonly string[] };
    const callers =
      search.allowedCallers ??
      (search.version && search.version >= "web_search_20260209" ? ["code_execution_20260120"] : []);
    return `Server search enabled${adapter === "anthropic-messages" && callers.some((caller) => caller.startsWith("code_execution")) ? " · includes server code execution" : ""}`;
  }
  if (!settings?.hostTool) return "Search disabled";
  if (settings.hostTool.backend === "kimi-formula" && adapter !== "kimi-chat")
    return "Kimi Formula search requires kimi-chat";
  return `Host search: ${settings.hostTool.backend}`;
}
