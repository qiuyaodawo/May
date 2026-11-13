import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { updateDefaultMayModel, type MayConfig } from "@sortedyuan/may/config";
import type { ContextBudget } from "@sortedyuan/may/context";
import { omitUndefined, type Model } from "@sortedyuan/may/core";
import {
  type McpOAuthManager,
  type McpTaskJournal,
  validateMcpServerOptions,
  type McpServerBaseOptions,
  type McpServerOptions,
  type McpOAuthOptions,
} from "@sortedyuan/mcp";
import type { RetryingModelOptions } from "@sortedyuan/providers";
import type { ProjectGitWorkspaceOptions } from "@sortedyuan/may/application/git-workspace";
import { MaybeCodeConfigError } from "./errors.js";
import { readMaybeCodeSettings, type MaybeCodeSettings } from "./settings.js";
import type { MaybeCodeAutoCompactionMode } from "./controller.js";
import type { SelectedMaybeCodeModel } from "./model.js";
import type { ConfiguredMaybeCodeDependencies, MaybeCodeSubagentConfigurationOptions } from "./configured-options.js";
import {
  resolveSubagentConfiguration,
  type MaybeCodeSubagentConfiguration,
} from "@sortedyuan/coordination/delegation/configuration";

/** @experimental */
export interface MaybeCodeMcpOptions {
  readonly servers: readonly McpServerOptions[];
  readonly oauth?: McpOAuthManager;
  readonly taskJournal?: McpTaskJournal;
}

/** @experimental */
export interface MaybeCodeObservabilityOptions {
  /** Absolute path, or a path relative to MaybeCode's data directory. */
  readonly file?: string;
  readonly samplingRatio?: number;
  /** Local calendar days retained, including today. Defaults to 60. */
  readonly retentionDays?: number;
  readonly maxQueueSize?: number;
  readonly maxExportBatchSize?: number;
  readonly scheduledDelayMs?: number;
}

export function getDefaultMaybeCodeDataDirectory(): string {
  return join(homedir(), ".may", "maybecode");
}

export interface MaybeCodeRecording {
  readonly requestRecording: "off" | "required";
  readonly providerBodyRecording: boolean;
}

export function resolveMaybeCodeRecording(config: MayConfig): MaybeCodeRecording {
  const settings = readMaybeCodeSettings(config);
  return {
    requestRecording: settings.requestRecording ?? "required",
    providerBodyRecording: settings.providerBodyRecording ?? false,
  };
}

export function resolveMaybeCodeGit(config: MayConfig): false | Omit<ProjectGitWorkspaceOptions, "workspace"> {
  const git = readMaybeCodeSettings(config).git;
  if (git === false) return false;
  return omitUndefined({
    autoCommit: git?.autoCommit,
    readOnly: git?.readOnly,
    dataRoot: git?.dataRoot === undefined ? undefined : resolveGitConfigurationPath(config.path, git.dataRoot),
    worktreesRoot:
      git?.worktreesRoot === undefined ? undefined : resolveGitConfigurationPath(config.path, git.worktreesRoot),
    excludedPaths: git?.excludedPaths === undefined ? undefined : [...git.excludedPaths],
  });
}

function resolveGitConfigurationPath(configPath: string, path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(homedir(), path.slice(2));
  return resolve(dirname(configPath), path);
}

export function resolveMaybeCodeMcp(
  config: MayConfig,
  workspace: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): false | MaybeCodeMcpOptions {
  const servers = readMaybeCodeSettings(config).mcpServers;
  if (servers === undefined || servers === false) return false;
  const resolved: McpServerOptions[] = [];
  for (const [id, server] of Object.entries(servers)) {
    if (server.enabled === false) continue;
    const field = `apps.maybecode.mcpServers.${id}`;
    const common: McpServerBaseOptions = omitUndefined({
      id,
      required: server.required,
      protocolMode: server.protocolMode,
      tasks: server.tasks,
      host: server.host,
      requestTimeoutMs: server.requestTimeoutMs,
      maxTotalTimeoutMs: server.maxTotalTimeoutMs,
    });
    if (server.transport === "streamable-http") {
      const endpoint: McpServerOptions = omitUndefined({
        ...common,
        transport: "streamable-http" as const,
        url: server.url!,
        headers: resolveMcpEnvironment(server.headers, `${field}.headers`, environment),
        auth: server.auth as McpOAuthOptions | undefined,
      });
      try {
        validateMcpServerOptions(endpoint);
      } catch (error) {
        throw new MaybeCodeConfigError((error as Error).message, { cause: error });
      }
      resolved.push(endpoint);
      continue;
    }
    resolved.push(
      omitUndefined({
        ...common,
        command: server.command!,
        args: server.args,
        cwd: server.cwd === undefined ? workspace : resolve(workspace, server.cwd),
        env: resolveMcpEnvironment(server.env, `${field}.env`, environment),
        maxBufferSize: server.maxBufferSize,
        stderrMaxBytes: server.stderrMaxBytes,
      }),
    );
  }
  return { servers: resolved };
}

export function resolveMaybeCodeObservability(config: MayConfig): false | MaybeCodeObservabilityOptions {
  const observability = readMaybeCodeSettings(config).observability;
  if (observability === undefined || observability === false) return false;
  const batch = observability.batch ?? {};
  if ((batch.maxExportBatchSize ?? 512) > (batch.maxQueueSize ?? 2_048)) {
    throw new MaybeCodeConfigError("apps.maybecode.observability.batch.maxExportBatchSize cannot exceed maxQueueSize");
  }
  if (observability.enabled === false) return false;
  return omitUndefined({
    file: observability.file,
    samplingRatio: observability.samplingRatio,
    retentionDays: observability.retentionDays,
    maxQueueSize: batch.maxQueueSize,
    maxExportBatchSize: batch.maxExportBatchSize,
    scheduledDelayMs: batch.scheduledDelayMs,
  });
}

export function resolveMaybeCodeAutoCompactionMode(config: MayConfig): MaybeCodeAutoCompactionMode {
  return readMaybeCodeSettings(config).autoCompaction?.mode ?? "prune-summary";
}

export function resolveMaybeCodeRetry(config: MayConfig): false | RetryingModelOptions {
  const retry = readMaybeCodeSettings(config).retry;
  if (retry === false) return false;
  if ((retry?.baseDelayMs ?? 500) > (retry?.maxDelayMs ?? 8_000)) {
    throw new MaybeCodeConfigError("apps.maybecode.retry.baseDelayMs cannot exceed maxDelayMs");
  }
  return { ...retry };
}

export function resolveMaybeCodeSubagents(
  value: false | MaybeCodeSubagentConfigurationOptions | undefined,
  settings: MaybeCodeSettings,
): false | ResolvedSubagents {
  if (value === false) return false;
  if (value?.configuration !== undefined) return value as ResolvedSubagents;
  const resolved = resolveSubagentConfiguration(settings.subagents);
  if (resolved === false) return false;
  return { ...(value ?? {}), configuration: resolved };
}

type ResolvedSubagents = MaybeCodeSubagentConfigurationOptions & {
  readonly configuration: MaybeCodeSubagentConfiguration;
};

export function resolveDefaultModelPersistence(
  config: MayConfig,
  dependencies: ConfiguredMaybeCodeDependencies,
): { persistDefaultModel?: (profile: string) => Promise<void> } {
  if (dependencies.persistDefaultModel !== undefined) {
    return { persistDefaultModel: dependencies.persistDefaultModel };
  }
  if (dependencies.loadConfig !== undefined) return {};
  return {
    persistDefaultModel: async (profile) => {
      await updateDefaultMayModel(config.path, profile);
    },
  };
}

export function createContextBudget(model: Model, selection: SelectedMaybeCodeModel): ContextBudget | undefined {
  const contextWindowTokens = model.limits?.contextWindowTokens ?? selection.limits?.contextWindowTokens;
  const outputReserveTokens = model.limits?.maxOutputTokens ?? selection.limits?.maxOutputTokens;
  if (contextWindowTokens === undefined && outputReserveTokens === undefined) {
    return undefined;
  }
  return omitUndefined({ contextWindowTokens, outputReserveTokens });
}

export async function resolveWorkspace(workspace: string): Promise<string> {
  if (process.platform === "win32" && /^[A-Za-z]:(?:$|[^\\/])/u.test(workspace)) {
    throw new Error(
      `Workspace path "${workspace}" is drive-relative. ` +
        "Git Bash removes unquoted backslashes; use forward slashes " +
        "(for example E:/code/project) or single-quote the path.",
    );
  }
  const path = await realpath(resolve(workspace));
  const information = await stat(path);
  if (!information.isDirectory()) {
    throw new Error(`Workspace is not a directory: ${workspace}`);
  }
  return path;
}

function resolveMcpEnvironment(
  configured: Readonly<Record<string, string>> | undefined,
  field: string,
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> | undefined {
  if (configured === undefined) return undefined;
  const resolved: Record<string, string> = {};
  for (const [name, raw] of Object.entries(configured)) {
    resolved[name] = raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_match, environmentName: string) => {
      const replacement = environment[environmentName];
      if (replacement === undefined) {
        throw new MaybeCodeConfigError(`${field}.${name} references missing environment variable ${environmentName}`);
      }
      return replacement;
    });
  }
  return resolved;
}
