import { createApplicationConfigValidator, type MayConfig } from "@sortedyuan/may/config";
import type { RunBudget } from "@sortedyuan/may/core";
import type { PluginModuleSelection } from "@sortedyuan/may/plugin";
import type { MaybeCodeSubagentSettings } from "@sortedyuan/coordination/delegation/configuration";
import section from "./config-schema.json" with { type: "json" };

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
  return validate(config.apps?.[MAYBECODE_APPLICATION_ID] ?? {}, config.path);
}
