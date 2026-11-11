import { createApplicationConfigValidator, MayConfigValidationError, type MayConfig } from "@sortedyuan/may/config";
import type { RunBudget } from "@sortedyuan/may/core";
import type { PluginModuleSelection } from "@sortedyuan/may/plugin";
import type { MaybeCodeSubagentSettings } from "@sortedyuan/coordination/delegation/configuration";
import section from "./config-schema.json" with { type: "json" };
import type { CodingExecutionIsolation, FetchToolOptions } from "@sortedyuan/coding-tools";
import type { LanguageServerDefinition, LanguageServerManagerOptions } from "@sortedyuan/lsp-tools";
import { LANGUAGE_SERVER_PRESETS } from "@sortedyuan/lsp-tools";

export interface MaybeCodeLspSettings extends Omit<
  LanguageServerManagerOptions,
  "execution" | "servers" | "dataDirectory" | "guard"
> {
  readonly servers: Readonly<Record<string, Omit<LanguageServerDefinition, "id">>>;
  readonly editDiagnostics?: boolean;
}

export interface MaybeCodeWebSearchSettings {
  readonly hostTool?: {
    readonly backend: "deepseek" | "zhipu" | "kimi-formula";
    readonly provider: string;
    readonly searchEngine?: "search_std" | "search_pro" | "search_pro_sogou" | "search_pro_quark";
  };
  readonly maxResults?: number;
}

export const MAYBECODE_APPLICATION_ID = "maybecode";

export interface MaybeCodeGitSettings {
  readonly autoCommit?: boolean;
  readonly readOnly?: boolean;
  readonly dataRoot?: string;
  readonly worktreesRoot?: string;
  readonly excludedPaths?: readonly string[];
}

export interface MaybeCodeMcpHostSettings {
  readonly roots?: boolean;
  readonly sampling?: boolean;
  readonly legacyRequests?: "isolated";
}

interface MaybeCodeMcpServerBaseSettings {
  readonly enabled?: boolean;
  readonly required?: boolean;
  readonly protocolMode?: "legacy" | "auto";
  readonly host?: MaybeCodeMcpHostSettings;
  readonly tasks?: boolean;
  readonly requestTimeoutMs?: number;
  readonly maxTotalTimeoutMs?: number;
}

export interface MaybeCodeMcpStdioServerSettings extends MaybeCodeMcpServerBaseSettings {
  readonly transport?: "stdio";
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly maxBufferSize?: number;
  readonly stderrMaxBytes?: number;
}

export interface MaybeCodeMcpOAuthSettings {
  readonly type: "oauth";
  readonly account?: string;
  readonly clientId?: string;
  readonly expectedIssuer?: string;
  readonly clientMetadataUrl?: string;
  readonly scopes?: readonly string[];
  readonly authorizationOrigins?: readonly string[];
  readonly callbackPort?: number;
}

export interface MaybeCodeMcpHttpServerSettings extends MaybeCodeMcpServerBaseSettings {
  readonly transport: "streamable-http";
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly auth?: MaybeCodeMcpOAuthSettings;
}

export type MaybeCodeMcpServerSettings = MaybeCodeMcpStdioServerSettings | MaybeCodeMcpHttpServerSettings;

export interface MaybeCodeObservabilitySettings {
  readonly enabled?: boolean;
  readonly exporter?: "file";
  readonly file?: string;
  readonly samplingRatio?: number;
  readonly retentionDays?: number;
  readonly batch?: {
    readonly maxQueueSize?: number;
    readonly maxExportBatchSize?: number;
    readonly scheduledDelayMs?: number;
  };
}

export interface MaybeCodeRetrySettings {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly jitterRatio?: number;
}

/** The `apps.maybecode` entry of a May configuration file, validated against `config-schema.json`. */
export interface MaybeCodeSettings {
  readonly lsp?: false | MaybeCodeLspSettings;
  readonly webSearch?: false | MaybeCodeWebSearchSettings;
  readonly execution?: CodingExecutionIsolation;
  readonly fetch?: FetchToolOptions;
  readonly requestRecording?: "off" | "required";
  readonly providerBodyRecording?: boolean;
  readonly git?: false | MaybeCodeGitSettings;
  readonly plugins?: readonly PluginModuleSelection[];
  readonly permissionMode?: "default" | "yolo";
  readonly persistentRules?: boolean;
  readonly delegationNotifications?: boolean;
  readonly instructionsDirectory?: string;
  readonly skills?: false | { readonly directories?: readonly string[] };
  readonly runBudget?: RunBudget;
  readonly subagents?: false | MaybeCodeSubagentSettings;
  readonly autoCompaction?: { readonly mode?: "prune-summary" | "history-reference" | "provider-native" };
  readonly retry?: false | MaybeCodeRetrySettings;
  readonly observability?: false | MaybeCodeObservabilitySettings;
  readonly mcpServers?: false | Readonly<Record<string, MaybeCodeMcpServerSettings>>;
}

export const maybeCodeConfigSection = section;

const validate = createApplicationConfigValidator<MaybeCodeSettings>(MAYBECODE_APPLICATION_ID, section);

export function readMaybeCodeSettings(config: MayConfig): MaybeCodeSettings {
  const settings = validate(config.apps?.[MAYBECODE_APPLICATION_ID] ?? {}, config.path);
  if (settings.webSearch && settings.webSearch.hostTool) {
    const host = settings.webSearch.hostTool;
    const provider = config.providers[host.provider];
    if (!provider)
      throw new MayConfigValidationError(
        config.path,
        "apps.maybecode.webSearch.hostTool.provider",
        `unknown provider ${host.provider}`,
      );
    const apiKey = provider.apiKey ?? (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined);
    if (!apiKey?.trim())
      throw new MayConfigValidationError(
        config.path,
        "apps.maybecode.webSearch.hostTool.provider",
        "provider requires an API key",
      );
    if (host.backend === "zhipu" && !host.searchEngine)
      throw new MayConfigValidationError(
        config.path,
        "apps.maybecode.webSearch.hostTool.searchEngine",
        "Zhipu requires searchEngine",
      );
  }
  const names = new Set(["read", "shell", "edit", "write", "glob", "grep", "fetch"]);
  if (settings.webSearch && settings.webSearch.hostTool) names.add("web_search");
  if (settings.lsp) {
    for (const name of [
      "lsp_diagnostics",
      "lsp_definition",
      "lsp_references",
      "lsp_hover",
      "lsp_document_symbols",
      "lsp_workspace_symbols",
      "lsp_rename",
    ])
      names.add(name);
    const extensions = new Set<string>();
    for (const [id, server] of Object.entries(settings.lsp.servers)) {
      const preset = Object.entries(LANGUAGE_SERVER_PRESETS).find(([name]) => name === id)?.[1];
      if (!preset && (!server.command || !server.languages))
        throw new MayConfigValidationError(
          config.path,
          `apps.maybecode.lsp.servers.${id}`,
          "custom servers require command and languages",
        );
      for (const values of Object.values(server.languages ?? preset?.languages ?? {}))
        for (const value of values) {
          const extension = value.toLowerCase();
          if (extensions.has(extension))
            throw new MayConfigValidationError(
              config.path,
              "apps.maybecode.lsp.servers",
              `duplicate extension ${extension}`,
            );
          extensions.add(extension);
        }
    }
  }
  if (settings.subagents && settings.subagents.roles)
    for (const [role, options] of Object.entries(settings.subagents.roles))
      for (const name of options.tools ?? []) {
        if (!names.has(name))
          throw new MayConfigValidationError(
            config.path,
            `apps.maybecode.subagents.roles.${role}.tools`,
            `unregistered tool ${name}`,
          );
      }
  for (const [index, origin] of (settings.fetch?.allowedOrigins ?? []).entries()) {
    if (!URL.canParse(origin) || new URL(origin).origin !== origin)
      throw new MayConfigValidationError(
        config.path,
        `apps.maybecode.fetch.allowedOrigins.${index}`,
        "must be a canonical HTTP or HTTPS origin",
      );
  }
  return settings;
}
