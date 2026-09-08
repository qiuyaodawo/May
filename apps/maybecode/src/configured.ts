import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  loadMayConfig,
  updateDefaultMayModel,
  type LoadMayConfigOptions,
  type MayConfig,
} from "@may/config";
import type {
  ContextBudget,
  ContextCompactionStrategy,
  ContextFactory,
  ContextSummarizer,
} from "@may/context";
import { resolveRunBudget, type Model, type RunBudget } from "@may/core";
import {
  openMcpClientPool,
  KeyringMcpCredentialStore,
  McpOAuthManager,
  McpInteractionBroker,
  McpTaskJournal,
  createMcpModelSampler,
  type McpHostRequestContext,
  type McpServerHostOptions,
  validateMcpServerOptions,
  type McpClientPool,
  type McpServerBaseOptions,
  type McpServerOptions,
  type McpOAuthOptions,
  type OpenMcpClientPoolOptions,
} from "@may/mcp";
import {
  BasicTracer,
  BatchSpanProcessor,
  JsonlFileSpanExporter,
  ratioSampler,
} from "@may/observability";
import {
  createModelCapabilityResolver,
  type ModelCapabilityResolver,
  type ProviderAdapterRegistry,
  withModelRetry,
  type RetryingModelOptions,
} from "@may/providers";
import { FileSessionStore } from "@may/session/file-store";

import { FileSessionCatalog } from "@may/session/catalog";
import { MaybeCodeConfigError } from "./errors.js";
import {
  createMaybeCodeModel,
  selectMaybeCodeModel,
  type MaybeCodeModelSelector,
  type SelectedMaybeCodeModel,
} from "./model.js";
import {
  MAYBECODE_APPLICATION_ID,
  resolveMaybeCodeInstructionsDirectory,
} from "./instructions.js";
import { MaybeCodeWorkspace } from "./workspace.js";
import type { MaybeCodeModelConfiguration } from "./workspace.js";
import type { SkillRegistry } from "@may/skills";
import { resolveMaybeCodeSkillDirectories } from "./skills.js";

export interface OpenConfiguredMaybeCodeOptions extends MaybeCodeModelSelector {
  /** Enable only when a UI consumes interaction events and answers the controller. */
  readonly mcpInteractions?: boolean;
  readonly workspace?: string;
  readonly configPath?: string;
  readonly dataDirectory?: string;
  readonly sessionId?: string;
  /** Resume the latest workspace session when no sessionId is given. Defaults to false. */
  readonly autoResume?: boolean;
  readonly contextFactory?: ContextFactory;
  readonly contextBudget?: ContextBudget;
  readonly compactionStrategy?: ContextCompactionStrategy;
  readonly autoCompactionStrategies?: readonly ContextCompactionStrategy[];
  readonly providerNativeAutoCompaction?: boolean;
  readonly contextSummarizer?: ContextSummarizer;
  readonly instructions?: string;
  readonly maxSteps?: number;
  readonly runBudget?: RunBudget;
  readonly skills?: SkillRegistry | false;
  readonly skillDirectories?: readonly string[];
  /** Disable retries with false, or override the configured retry policy. */
  readonly retry?: false | RetryingModelOptions;
  /** Disable tracing or override apps.maybecode.observability. */
  readonly observability?: false | MaybeCodeObservabilityOptions;
  /** Disable MCP or override apps.maybecode.mcpServers. */
  readonly mcp?: false | MaybeCodeMcpOptions;
}

export interface MaybeCodeMcpOptions {
  readonly servers: readonly McpServerOptions[];
  readonly oauth?: McpOAuthManager;
  readonly taskJournal?: McpTaskJournal;
}

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

export interface ConfiguredMaybeCodeDependencies {
  readonly loadConfig?: (
    options?: LoadMayConfigOptions,
  ) => Promise<MayConfig>;
  readonly createModel?: (selection: SelectedMaybeCodeModel) => Model;
  readonly adapterRegistry?: ProviderAdapterRegistry;
  readonly capabilityResolver?: ModelCapabilityResolver;
  readonly persistDefaultModel?: (profile: string) => Promise<void>;
  readonly openMcp?: (
    options: OpenMcpClientPoolOptions,
  ) => Promise<McpClientPool>;
}

export function getDefaultMaybeCodeDataDirectory(): string {
  return join(homedir(), ".may", "maybecode");
}

export async function openConfiguredMaybeCode(
  options: OpenConfiguredMaybeCodeOptions = {},
  dependencies: ConfiguredMaybeCodeDependencies = {},
): Promise<MaybeCodeWorkspace> {
  const workspace = await resolveWorkspace(options.workspace ?? process.cwd());
  const loadConfig = dependencies.loadConfig ?? loadMayConfig;
  const config = await loadConfig(
    options.configPath === undefined ? {} : { path: options.configPath },
  );
  const retry = options.retry ?? resolveMaybeCodeRetry(config);
  const skillDirectories = options.skillDirectories ?? resolveMaybeCodeSkillDirectories(config, workspace);
  const runBudget = resolveRunBudget(options.runBudget ?? config.apps?.maybecode?.runBudget as RunBudget | undefined);
  const capabilityResolver = dependencies.capabilityResolver ??
    createModelCapabilityResolver();
  const selectionFor = (profile?: string): SelectedMaybeCodeModel =>
    selectMaybeCodeModel(config, {
      ...(profile === undefined ? {} : { model: profile }),
    });
  const configureModel = (
    profile?: string,
    runtimeOptions: Readonly<Record<string, unknown>> = {},
  ): MaybeCodeModelConfiguration => {
    const selected = selectionFor(profile);
    const selection: SelectedMaybeCodeModel = {
      ...selected,
      options: { ...selected.options, ...runtimeOptions },
    };
    const baseModel = dependencies.createModel === undefined
      ? createMaybeCodeModel(selection, dependencies.adapterRegistry)
      : dependencies.createModel(selection);
    const model = retry === false ? baseModel : withModelRetry(baseModel, retry);
    const contextBudget = options.contextBudget ?? createContextBudget(
      model,
      selection,
    );
    return {
      model,
      modelInfo: {
        profile: selection.profile,
        provider: selection.provider,
        adapter: selection.adapter,
        model: selection.model,
      },
      ...(contextBudget === undefined ? {} : { contextBudget }),
    };
  };
  const initialModel = configureModel(options.model);
  const modelProfiles = Object.entries(config.models).map(([name, profile]) => {
    const provider = config.providers[profile.provider]!;
    const reasoningEffort = {
      ...(provider.options ?? {}),
      ...(profile.options ?? {}),
    }.reasoningEffort;
    return {
      name,
      provider: profile.provider,
      adapter: profile.adapter ?? provider.adapter,
      model: profile.model,
      isDefault: config.defaultModel === name,
      ...(typeof reasoningEffort === "string" ? { reasoningEffort } : {}),
    };
  });
  const instructionsDirectory = options.instructions === undefined
    ? resolveMaybeCodeInstructionsDirectory(config)
    : undefined;
  const providerNativeAutoCompaction =
    options.providerNativeAutoCompaction ??
      resolveProviderNativeAutoCompaction(config);
  const dataDirectory = resolve(
    options.dataDirectory ?? getDefaultMaybeCodeDataDirectory(),
  );
  const observabilityOptions = options.observability ??
    resolveMaybeCodeObservability(config);
  const observability = observabilityOptions === false
    ? undefined
    : createMaybeCodeObservability(observabilityOptions, dataDirectory);
  const mcpOptions = options.mcp ?? resolveMaybeCodeMcp(config, workspace);
  let mcp: McpClientPool | undefined;
  let application: MaybeCodeWorkspace | undefined;
  const checkHostOwner = (context: McpHostRequestContext) => {
    context.signal.throwIfAborted();
    if (application === undefined || context.owner.workspaceId !== application.workspace || context.owner.sessionId !== application.sessionId) throw new Error("MCP host request has no active workspace/Session owner");
  };

  try {
    if (mcpOptions !== false && mcpOptions.servers.length > 0) {
      mcp = await (dependencies.openMcp ?? openMcpClientPool)({
        servers: mcpOptions.servers,
        ...(mcpOptions.servers.some((server) => server.tasks) ? {
          taskJournal: mcpOptions.taskJournal ?? new McpTaskJournal(new KeyringMcpCredentialStore(join(dataDirectory, "mcp-tasks"))),
        } : {}),
        ...(options.mcpInteractions === true ? { interactions: new McpInteractionBroker() } : {}),
        hostServices: {
          roots: async (context) => { checkHostOwner(context); return [{ uri: pathToFileURL(workspace).href, name: "MaybeCode workspace" }]; },
          sampling: createMcpModelSampler((maxTokens, context) => {
            checkHostOwner(context);
            const selected = selectionFor(application!.modelInfo?.profile);
            const selection = { ...selected, options: { ...selected.options, maxTokens, maxOutputTokens: maxTokens } };
            // A separate provider instance, without automatic retry or Session Context.
            const model = dependencies.createModel === undefined ? createMaybeCodeModel(selection, dependencies.adapterRegistry) : dependencies.createModel(selection);
            return { model, name: selected.model };
          }),
        },
        ...(mcpOptions.servers.some((server) => server.transport === "streamable-http" && server.auth !== undefined)
          ? { oauth: mcpOptions.oauth ?? new McpOAuthManager(new KeyringMcpCredentialStore(join(dataDirectory, "mcp-credentials"))) }
          : {}),
        ...(observability === undefined
          ? {}
          : { tracer: observability.tracer }),
        traceAttributes: { "may.agent.name": "maybecode" },
      });
    }
    application = await MaybeCodeWorkspace.open({
      workspace,
      model: initialModel.model,
      modelInfo: initialModel.modelInfo,
      modelProfiles,
      createModelConfiguration: (profile, runtimeOptions) =>
        configureModel(profile, runtimeOptions),
      resolveModelCapabilities: async (profile) =>
        capabilityResolver.resolve(selectionFor(profile)),
      ...resolveDefaultModelPersistence(config, dependencies),
      store: new FileSessionStore(join(dataDirectory, "sessions")),
      catalog: new FileSessionCatalog(join(dataDirectory, "catalog.json")),
      ...(mcp === undefined
        ? {}
        : { toolSource: () => mcp!.tools, mcp }),
      ...(mcp === undefined && observability === undefined
        ? {}
        : {
            ...(observability === undefined
              ? {}
              : { tracer: observability.tracer }),
            closeOwnedResources: () =>
              closeConfiguredResources(mcp, observability?.processor),
          }),
      ...(options.sessionId === undefined
        ? {}
        : { sessionId: options.sessionId }),
      ...(options.autoResume === undefined
        ? {}
        : { autoResume: options.autoResume }),
      ...(options.contextFactory === undefined
        ? {}
        : { contextFactory: options.contextFactory }),
      ...(initialModel.contextBudget === undefined
        ? {}
        : { contextBudget: initialModel.contextBudget }),
      ...(options.compactionStrategy === undefined
        ? {}
        : { compactionStrategy: options.compactionStrategy }),
      ...(options.autoCompactionStrategies === undefined
        ? {}
        : { autoCompactionStrategies: options.autoCompactionStrategies }),
      providerNativeAutoCompaction,
      ...(options.contextSummarizer === undefined
        ? {}
        : { contextSummarizer: options.contextSummarizer }),
      ...(options.instructions === undefined
        ? {}
        : { instructions: options.instructions }),
      ...(instructionsDirectory === undefined
        ? {}
        : { instructionsDirectory }),
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
      runBudget,
      ...(options.skills === undefined ? {} : { skills: options.skills }),
      ...(skillDirectories === false
        ? (options.skills === undefined ? { skills: false as const } : {})
        : { skillDirectories }),
    });
    return application;
  } catch (error) {
    try {
      await closeConfiguredResources(mcp, observability?.processor);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "MaybeCode failed to open and release configured resources",
      );
    }
    throw error;
  }
}

export function resolveMaybeCodeMcp(
  config: MayConfig,
  workspace: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): false | MaybeCodeMcpOptions {
  const value = config.apps?.[MAYBECODE_APPLICATION_ID]?.mcpServers;
  if (value === undefined || value === false) return false;
  const servers = objectValue(value, "apps.maybecode.mcpServers");
  const resolved: McpServerOptions[] = [];

  for (const [id, raw] of Object.entries(servers)) {
    if (!/^[A-Za-z0-9_-]+$/u.test(id)) {
      throw new MaybeCodeConfigError(
        `apps.maybecode.mcpServers server id "${id}" may contain only letters, digits, underscores, and hyphens`,
      );
    }
    const field = `apps.maybecode.mcpServers.${id}`;
    const server = objectValue(raw, field);
    rejectUnknownOptions(
      server,
      [
        "enabled",
        "required",
        "transport",
        "protocolMode",
        "host",
        "tasks",
        "url",
        "headers",
        "auth",
        "command",
        "args",
        "cwd",
        "env",
        "requestTimeoutMs",
        "maxTotalTimeoutMs",
        "maxBufferSize",
        "stderrMaxBytes",
      ],
      field,
    );
    if (server.enabled !== undefined && typeof server.enabled !== "boolean") {
      throw new MaybeCodeConfigError(`${field}.enabled must be a boolean`);
    }
    if (server.enabled === false) continue;
    if (server.required !== undefined && typeof server.required !== "boolean") {
      throw new MaybeCodeConfigError(`${field}.required must be a boolean`);
    }
    if (server.transport !== undefined && server.transport !== "stdio" &&
        server.transport !== "streamable-http") {
      throw new MaybeCodeConfigError(`${field}.transport must be "stdio" or "streamable-http"`);
    }
    if (server.protocolMode !== undefined && server.protocolMode !== "legacy" &&
        server.protocolMode !== "auto") {
      throw new MaybeCodeConfigError(`${field}.protocolMode must be "legacy" or "auto"`);
    }
    const requestTimeoutMs = optionalPositiveInteger(
      server.requestTimeoutMs,
      `${field}.requestTimeoutMs`,
    );
    const maxTotalTimeoutMs = optionalPositiveInteger(
      server.maxTotalTimeoutMs,
      `${field}.maxTotalTimeoutMs`,
    );
    const common: McpServerBaseOptions = {
      id,
      ...(server.required === undefined ? {} : { required: server.required }),
      ...(server.protocolMode === undefined ? {} : { protocolMode: server.protocolMode }),
      ...(server.tasks === undefined ? {} : { tasks: server.tasks as boolean }),
      ...(server.host === undefined ? {} : { host: objectValue(server.host, `${field}.host`) as McpServerHostOptions }),
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
      ...(maxTotalTimeoutMs === undefined ? {} : { maxTotalTimeoutMs }),
    };
    if (server.transport === "streamable-http") {
      for (const key of ["command", "args", "cwd", "env", "maxBufferSize", "stderrMaxBytes"]) {
        if (key in server) throw new MaybeCodeConfigError(`${field}.${key} is stdio-only`);
      }
      const headers = resolveMcpEnvironment(server.headers, `${field}.headers`, environment);
      const endpoint: McpServerOptions = {
        ...common,
        transport: "streamable-http",
        url: nonEmptyString(server.url, `${field}.url`),
        ...(headers === undefined ? {} : { headers }),
        ...(server.auth === undefined ? {} : { auth: objectValue(server.auth, `${field}.auth`) as unknown as McpOAuthOptions }),
      };
      try {
        validateMcpServerOptions(endpoint);
      } catch (error) {
        throw new MaybeCodeConfigError(error instanceof Error ? error.message : "Invalid MCP endpoint");
      }
      resolved.push(endpoint);
      continue;
    }
    for (const key of ["url", "headers", "auth"]) {
      if (key in server) throw new MaybeCodeConfigError(`${field}.${key} requires streamable-http`);
    }
    const command = nonEmptyString(server.command, `${field}.command`);
    const args = optionalStringArray(server.args, `${field}.args`);
    const cwd = server.cwd === undefined
      ? workspace
      : resolve(workspace, nonEmptyString(server.cwd, `${field}.cwd`));
    const env = resolveMcpEnvironment(server.env, `${field}.env`, environment);
    const maxBufferSize = optionalPositiveInteger(
      server.maxBufferSize,
      `${field}.maxBufferSize`,
    );
    const stderrMaxBytes = optionalPositiveInteger(
      server.stderrMaxBytes,
      `${field}.stderrMaxBytes`,
    );

    resolved.push({
      ...common,
      command,
      ...(args === undefined ? {} : { args }),
      cwd,
      ...(env === undefined ? {} : { env }),
      ...(maxBufferSize === undefined ? {} : { maxBufferSize }),
      ...(stderrMaxBytes === undefined ? {} : { stderrMaxBytes }),
    });
  }

  return { servers: resolved };
}

export function resolveMaybeCodeObservability(
  config: MayConfig,
): false | MaybeCodeObservabilityOptions {
  const value = config.apps?.[MAYBECODE_APPLICATION_ID]?.observability;
  if (value === undefined || value === false) return false;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MaybeCodeConfigError(
      "apps.maybecode.observability must be false or an object",
    );
  }

  const candidate = value as Record<string, unknown>;
  rejectUnknownOptions(
    candidate,
    [
      "enabled",
      "exporter",
      "file",
      "samplingRatio",
      "retentionDays",
      "batch",
    ],
    "apps.maybecode.observability",
  );
  const enabled = candidate.enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new MaybeCodeConfigError(
      "apps.maybecode.observability.enabled must be a boolean",
    );
  }
  if (candidate.exporter !== undefined && candidate.exporter !== "file") {
    throw new MaybeCodeConfigError(
      'apps.maybecode.observability.exporter must be "file"',
    );
  }
  const file = candidate.file === undefined
    ? undefined
    : nonEmptyString(
        candidate.file,
        "apps.maybecode.observability.file",
      );
  const samplingRatio = optionalRatio(
    candidate.samplingRatio,
    "apps.maybecode.observability.samplingRatio",
  );
  const retentionDays = optionalPositiveInteger(
    candidate.retentionDays,
    "apps.maybecode.observability.retentionDays",
  );
  const batch = candidate.batch === undefined
    ? {}
    : objectValue(candidate.batch, "apps.maybecode.observability.batch");
  rejectUnknownOptions(
    batch,
    ["maxQueueSize", "maxExportBatchSize", "scheduledDelayMs"],
    "apps.maybecode.observability.batch",
  );
  const maxQueueSize = optionalPositiveInteger(
    batch.maxQueueSize,
    "apps.maybecode.observability.batch.maxQueueSize",
  );
  const maxExportBatchSize = optionalPositiveInteger(
    batch.maxExportBatchSize,
    "apps.maybecode.observability.batch.maxExportBatchSize",
  );
  const scheduledDelayMs = optionalNonNegativeNumber(
    batch.scheduledDelayMs,
    "apps.maybecode.observability.batch.scheduledDelayMs",
  );
  if ((maxExportBatchSize ?? 512) > (maxQueueSize ?? 2_048)) {
    throw new MaybeCodeConfigError(
      "apps.maybecode.observability.batch.maxExportBatchSize cannot exceed maxQueueSize",
    );
  }
  if (enabled === false) return false;
  return {
    ...(file === undefined ? {} : { file }),
    ...(samplingRatio === undefined ? {} : { samplingRatio }),
    ...(retentionDays === undefined ? {} : { retentionDays }),
    ...(maxQueueSize === undefined ? {} : { maxQueueSize }),
    ...(maxExportBatchSize === undefined ? {} : { maxExportBatchSize }),
    ...(scheduledDelayMs === undefined ? {} : { scheduledDelayMs }),
  };
}

function createMaybeCodeObservability(
  options: MaybeCodeObservabilityOptions,
  dataDirectory: string,
) {
  const exporter = new JsonlFileSpanExporter({
    path: resolve(dataDirectory, options.file ?? "traces/traces.jsonl"),
    rotation: "daily",
    retentionDays: options.retentionDays ?? 60,
  });
  const processor = new BatchSpanProcessor(exporter, {
    ...(options.maxQueueSize === undefined
      ? {}
      : { maxQueueSize: options.maxQueueSize }),
    ...(options.maxExportBatchSize === undefined
      ? {}
      : { maxExportBatchSize: options.maxExportBatchSize }),
    ...(options.scheduledDelayMs === undefined
      ? {}
      : { scheduledDelayMs: options.scheduledDelayMs }),
  });
  return {
    processor,
    tracer: new BasicTracer({
      processor,
      sampler: ratioSampler(options.samplingRatio ?? 1),
      resourceAttributes: { "service.name": "maybecode" },
    }),
  };
}

function resolveDefaultModelPersistence(
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

export function resolveProviderNativeAutoCompaction(
  config: MayConfig,
): boolean {
  const value = config.apps?.[MAYBECODE_APPLICATION_ID]?.autoCompaction;
  if (value === undefined) return false;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MaybeCodeConfigError(
      "apps.maybecode.autoCompaction must be an object",
    );
  }
  const providerNative = (value as Record<string, unknown>).providerNative;
  if (providerNative === undefined) return false;
  if (typeof providerNative !== "boolean") {
    throw new MaybeCodeConfigError(
      "apps.maybecode.autoCompaction.providerNative must be a boolean",
    );
  }
  return providerNative;
}

export function resolveMaybeCodeRetry(
  config: MayConfig,
): false | RetryingModelOptions {
  const value = config.apps?.[MAYBECODE_APPLICATION_ID]?.retry;
  if (value === undefined) return {};
  if (value === false) return false;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MaybeCodeConfigError(
      "apps.maybecode.retry must be false or an object",
    );
  }

  const retry = value as Record<string, unknown>;
  const maxAttempts = optionalPositiveInteger(
    retry.maxAttempts,
    "apps.maybecode.retry.maxAttempts",
  );
  const baseDelayMs = optionalNonNegativeNumber(
    retry.baseDelayMs,
    "apps.maybecode.retry.baseDelayMs",
  );
  const maxDelayMs = optionalNonNegativeNumber(
    retry.maxDelayMs,
    "apps.maybecode.retry.maxDelayMs",
  );
  const jitterRatio = optionalRatio(
    retry.jitterRatio,
    "apps.maybecode.retry.jitterRatio",
  );
  if ((baseDelayMs ?? 500) > (maxDelayMs ?? 8_000)) {
    throw new MaybeCodeConfigError(
      "apps.maybecode.retry.baseDelayMs cannot exceed maxDelayMs",
    );
  }
  return {
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
    ...(baseDelayMs === undefined ? {} : { baseDelayMs }),
    ...(maxDelayMs === undefined ? {} : { maxDelayMs }),
    ...(jitterRatio === undefined ? {} : { jitterRatio }),
  };
}

function createContextBudget(
  model: Model,
  selection: SelectedMaybeCodeModel,
): ContextBudget | undefined {
  const contextWindowTokens = model.limits?.contextWindowTokens ??
    selection.limits?.contextWindowTokens;
  const outputReserveTokens = model.limits?.maxOutputTokens ??
    selection.limits?.maxOutputTokens;
  if (contextWindowTokens === undefined && outputReserveTokens === undefined) {
    return undefined;
  }
  return {
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    ...(outputReserveTokens === undefined ? {} : { outputReserveTokens }),
  };
}

async function resolveWorkspace(workspace: string): Promise<string> {
  if (
    process.platform === "win32" && /^[A-Za-z]:(?:$|[^\\/])/u.test(workspace)
  ) {
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

function optionalPositiveInteger(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new MaybeCodeConfigError(`${field} must be a positive safe integer`);
  }
  return value as number;
}

function optionalNonNegativeNumber(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new MaybeCodeConfigError(`${field} must be a non-negative number`);
  }
  return value;
}

function optionalRatio(value: unknown, field: string): number | undefined {
  const number = optionalNonNegativeNumber(value, field);
  if (number !== undefined && number > 1) {
    throw new MaybeCodeConfigError(`${field} must be between 0 and 1`);
  }
  return number;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new MaybeCodeConfigError(`${field} must be a non-empty string`);
  }
  return value;
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MaybeCodeConfigError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalStringArray(
  value: unknown,
  field: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new MaybeCodeConfigError(`${field} must be an array of strings`);
  }
  return [...value] as string[];
}

function resolveMcpEnvironment(
  value: unknown,
  field: string,
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const configured = objectValue(value, field);
  const resolved: Record<string, string> = {};
  for (const [name, raw] of Object.entries(configured)) {
    if (name === "" || typeof raw !== "string") {
      throw new MaybeCodeConfigError(`${field} must contain string values`);
    }
    resolved[name] = raw.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu,
      (_match, environmentName: string) => {
        const replacement = environment[environmentName];
        if (replacement === undefined) {
          throw new MaybeCodeConfigError(
            `${field}.${name} references missing environment variable ${environmentName}`,
          );
        }
        return replacement;
      },
    );
  }
  return resolved;
}

interface Shutdownable {
  shutdown(): Promise<void>;
}

async function closeConfiguredResources(
  mcp: McpClientPool | undefined,
  observability: Shutdownable | undefined,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await mcp?.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    await observability?.shutdown();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "One or more MaybeCode resources failed to close",
    );
  }
}

function rejectUnknownOptions(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const names = new Set(allowed);
  const unknown = Object.keys(value).find((name) => !names.has(name));
  if (unknown !== undefined) {
    throw new MaybeCodeConfigError(`${field}.${unknown} is not supported`);
  }
}
