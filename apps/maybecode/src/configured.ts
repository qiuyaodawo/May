import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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
  type McpOAuthManager,
  type McpTaskJournal,
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
import { mcpHostService, mcpService, type McpPluginOptions } from "@may/plugin-mcp";
import { createSharedObservabilityPlugin, observabilityHostService, observabilityService } from "@may/plugin-observability";
import { services } from "@may/plugin-services";
import { createMaybeCodeResourcePlugins, createMaybeCodeSharedPlugins } from "./plugins/resources.js";
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
import type { MaybeCodeAutoCompactionMode } from "./controller.js";
import type { MaybeCodeModelConfiguration } from "./workspace.js";
import type { ProjectGitWorkspaceOptions } from "@may/application/git-workspace";
import type { SkillRegistry } from "@may/skills";
import { PluginHost, loadPluginModules, parsePluginSelections, type AnyPlugin, type ServiceToken } from "@may/plugin";
import { resolveMaybeCodeSkillDirectories } from "./skills.js";
import { parsePermissionMode, type MaybeCodePermissionMode } from "./policy.js";
import { resolveSubagentConfiguration, type MaybeCodeSubagentConfiguration, type MaybeCodeSubagentRole } from "./subagents.js";

export interface OpenConfiguredMaybeCodeOptions extends MaybeCodeModelSelector {
  readonly git?: false | Omit<ProjectGitWorkspaceOptions, "workspace">;
  readonly plugins?: readonly AnyPlugin[];
  readonly permissionMode?: MaybeCodePermissionMode;
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
  readonly autoCompactionMode?: MaybeCodeAutoCompactionMode;
  /** @deprecated Use autoCompactionMode instead. */
  readonly providerNativeAutoCompaction?: boolean;
  readonly contextSummarizer?: ContextSummarizer;
  readonly instructions?: string;
  readonly maxSteps?: number;
  readonly runBudget?: RunBudget;
  readonly skills?: SkillRegistry | false;
  readonly goals?: false;
  readonly skillDirectories?: readonly string[];
  /** Disable retries with false, or override the configured retry policy. */
  readonly retry?: false | RetryingModelOptions;
  /** Disable tracing or override apps.maybecode.observability. */
  readonly observability?: false | MaybeCodeObservabilityOptions;
  /** Disable MCP or override apps.maybecode.mcpServers. */
  readonly mcp?: false | MaybeCodeMcpOptions;
  /** 关闭子 Agent 委派，或覆盖 apps.maybecode.subagents。 */
  readonly subagents?: false | MaybeCodeSubagentConfigurationOptions;
}

export interface MaybeCodeSubagentConfigurationOptions {
  /** 角色、限制与额度；缺省时注册 worker 角色。 */
  readonly configuration?: MaybeCodeSubagentConfiguration;
  /** 每次请求的协调记录根目录。 */
  readonly dataDirectory?: string;
  /** 声明了自己 profile 的角色使用的模型配置工厂。 */
  readonly createModel?: (role: MaybeCodeSubagentRole) => MaybeCodeModelConfiguration;
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

export function resolveMaybeCodeGit(config: MayConfig): false | Omit<ProjectGitWorkspaceOptions, "workspace"> {
  const value = config.apps?.maybecode?.git;
  if (value === undefined) return {};
  if (value === false) return false;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MaybeCodeConfigError("apps.maybecode.git must be false or an object");
  const fields = value as Record<string, unknown>;
  const allowed = ["autoCommit", "readOnly", "dataRoot", "worktreesRoot", "excludedPaths"];
  for (const name of Object.keys(fields)) if (!allowed.includes(name)) throw new MaybeCodeConfigError(`Unknown apps.maybecode.git field: ${name}`);
  for (const name of ["autoCommit", "readOnly"]) if (fields[name] !== undefined && typeof fields[name] !== "boolean") throw new MaybeCodeConfigError(`apps.maybecode.git.${name} must be boolean`);
  for (const name of ["dataRoot", "worktreesRoot"]) if (fields[name] !== undefined && (typeof fields[name] !== "string" || !fields[name].trim())) throw new MaybeCodeConfigError(`apps.maybecode.git.${name} must be a non-empty path`);
  if (fields.excludedPaths !== undefined && (!Array.isArray(fields.excludedPaths) || fields.excludedPaths.some(path => typeof path !== "string" || !path.trim()))) throw new MaybeCodeConfigError("apps.maybecode.git.excludedPaths must contain non-empty paths");
  return {
    ...(fields.autoCommit === undefined ? {} : { autoCommit: fields.autoCommit as boolean }),
    ...(fields.readOnly === undefined ? {} : { readOnly: fields.readOnly as boolean }),
    ...(fields.dataRoot === undefined ? {} : { dataRoot: resolveGitConfigurationPath(config.path, fields.dataRoot as string) }),
    ...(fields.worktreesRoot === undefined ? {} : { worktreesRoot: resolveGitConfigurationPath(config.path, fields.worktreesRoot as string) }),
    ...(fields.excludedPaths === undefined ? {} : { excludedPaths: fields.excludedPaths as string[] }),
  };
}

function resolveGitConfigurationPath(configPath: string, path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(homedir(), path.slice(2));
  return resolve(dirname(configPath), path);
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
  const plugins = options.plugins ?? await loadPluginModules(
    parsePluginSelections(config.apps?.maybecode?.plugins), config.path,
  );
  const provided = (service: ServiceToken<unknown>) => plugins.some(plugin =>
    plugin.provides?.some(candidate => candidate.id === service.id && candidate.scope === service.scope));
  const pluginModel = provided(services.model);
  const configuredPermissionMode = config.apps?.maybecode?.permissionMode;
  const git = options.git ?? resolveMaybeCodeGit(config);
  const permissionMode = options.permissionMode === undefined
    ? configuredPermissionMode === undefined ? "default" : parsePermissionMode(configuredPermissionMode)
    : parsePermissionMode(options.permissionMode);
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
  const initialModel = pluginModel ? undefined : configureModel(options.model);
  const modelProfiles = pluginModel ? [] : Object.entries(config.models).map(([name, profile]) => {
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
  const autoCompactionMode = options.autoCompactionMode ??
    (options.providerNativeAutoCompaction === undefined
      ? resolveMaybeCodeAutoCompactionMode(config)
      : options.providerNativeAutoCompaction ? "provider-native" : "prune-summary");
  const dataDirectory = resolve(
    options.dataDirectory ?? getDefaultMaybeCodeDataDirectory(),
  );
  const observabilityOptions = provided(observabilityService) || provided(services.tracer) ? false : options.observability ??
    resolveMaybeCodeObservability(config);
  const subagents = resolveMaybeCodeSubagents(options.subagents, config);
  const subagentCreateModel = (role: MaybeCodeSubagentRole): MaybeCodeModelConfiguration | undefined =>
    role.model === undefined
      ? initialModel
      : configureModel(role.model, role.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: role.reasoningEffort });
  let mcp: McpClientPool | undefined;
  let resourceHost: PluginHost | undefined;
  const workspaceResourceHosts = new Map<string, PluginHost>();
  const workspacePlugins = new Map<string, readonly AnyPlugin[]>();
  let application: MaybeCodeWorkspace | undefined;
  const checkHostOwner = (context: McpHostRequestContext) => {
    context.signal.throwIfAborted();
    if (application === undefined) throw new Error("MCP host request has no active workspace/Session owner");
    // 子 Agent Session 属于同一个工作区，并且各自持有身份与授权记录。
    if (context.owner.workspaceId !== application.workspace || !application.ownsSession(context.owner.sessionId)) {
      throw new Error("MCP host request has no active workspace/Session owner");
    }
  };

  const mcpForWorkspace = (nextWorkspace: string): false | McpPluginOptions => {
    const next = provided(mcpService) ? false : options.mcp === undefined
      ? resolveMaybeCodeMcp(config, nextWorkspace)
      : options.mcp === false ? false : { ...options.mcp, servers: options.mcp.servers.map(server => {
        if (server.transport === "streamable-http") return server;
        const source = resolve(workspace, server.cwd ?? ".");
        const path = relative(workspace, source);
        const inside = path === "" || path !== ".." && !path.startsWith("..\\") && !path.startsWith("../") && !isAbsolute(path);
        return { ...server, cwd: inside ? resolve(nextWorkspace, path) : source };
      }) };
    if (next === false) return false;
    const tracer = resourceHost?.provides(observabilityHostService) ? resourceHost.get(observabilityHostService).tracer : undefined;
    return {
      servers: next.servers,
      ...(next.taskJournal === undefined ? {} : { taskJournal: next.taskJournal }),
      ...(next.oauth === undefined ? {} : { oauth: next.oauth }),
      ...(tracer === undefined ? {} : { tracer }),
      ...(dependencies.openMcp === undefined ? {} : { open: dependencies.openMcp }),
      enableInteractions: options.mcpInteractions === true,
      hostServices: {
        roots: async (context) => { checkHostOwner(context); return [{ uri: pathToFileURL(application!.workspace).href, name: "MaybeCode workspace" }]; },
        ...(pluginModel ? {} : { sampling: createMcpModelSampler((maxTokens, context) => {
          checkHostOwner(context);
          const selected = selectionFor(application!.modelInfo?.profile);
          const selection = { ...selected, options: { ...selected.options, maxTokens, maxOutputTokens: maxTokens } };
          // sampling 使用独立 provider 实例和本次调用的模型预算。
          const model = dependencies.createModel === undefined ? createMaybeCodeModel(selection, dependencies.adapterRegistry) : dependencies.createModel(selection);
          return { model, name: selected.model };
        }) }),
      },
      traceAttributes: { "may.agent.name": "maybecode" },
    };
  };
  const closeResources = async () => {
    const results = await Promise.allSettled([...workspaceResourceHosts.values()].map(host => host.close()));
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    try { await resourceHost?.close(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "MaybeCode configured resources failed to close");
  };

  try {
    const resourcePlugins = createMaybeCodeResourcePlugins({ dataDirectory, observability: observabilityOptions, mcp: mcpForWorkspace(workspace) });
    resourceHost = await PluginHost.create({ plugins: resourcePlugins });
    if (resourceHost.provides(mcpHostService)) mcp = resourceHost.get(mcpHostService);
    const observability = resourceHost.provides(observabilityHostService) ? resourceHost.get(observabilityHostService) : undefined;
    const applicationPlugins = createMaybeCodeSharedPlugins(resourceHost, plugins);
    workspacePlugins.set(workspace, applicationPlugins);
    application = await MaybeCodeWorkspace.open({
      git,
      configureWorkspace: async nextWorkspace => {
        const directories = options.skillDirectories ?? resolveMaybeCodeSkillDirectories(config, nextWorkspace);
        let configuredPlugins = workspacePlugins.get(nextWorkspace);
        if (configuredPlugins === undefined) {
          const nextHost = await PluginHost.create({ plugins: createMaybeCodeResourcePlugins({
            dataDirectory, observability: false, mcp: mcpForWorkspace(nextWorkspace),
          }) });
          workspaceResourceHosts.set(nextWorkspace, nextHost);
          configuredPlugins = createMaybeCodeSharedPlugins(nextHost, [
            ...(observability === undefined ? [] : [createSharedObservabilityPlugin(observability)]), ...plugins,
          ]);
          workspacePlugins.set(nextWorkspace, configuredPlugins);
        }
        return { plugins: configuredPlugins, ...(directories === false ? { skills: false } : { skillDirectories: directories }) };
      },
      permissionMode,
      workspace,
      ...(initialModel === undefined ? {} : { model: initialModel.model, modelInfo: initialModel.modelInfo }),
      modelProfiles,
      ...(pluginModel ? {} : {
        createModelConfiguration: (profile: string, runtimeOptions?: Readonly<Record<string, unknown>>) => configureModel(profile, runtimeOptions),
        resolveModelCapabilities: async (profile: string) => capabilityResolver.resolve(selectionFor(profile)),
      }),
      ...resolveDefaultModelPersistence(config, dependencies),
      store: new FileSessionStore(join(dataDirectory, "sessions")),
      plugins: applicationPlugins,
      catalog: new FileSessionCatalog(join(dataDirectory, "catalog.json")),
      ...(mcp === undefined
        ? {}
        : { mcp }),
      closeOwnedResources: closeResources,
      ...(options.sessionId === undefined
        ? {}
        : { sessionId: options.sessionId }),
      ...(options.autoResume === undefined
        ? {}
        : { autoResume: options.autoResume }),
      ...(options.contextFactory === undefined
        ? {}
        : { contextFactory: options.contextFactory }),
      ...((options.contextBudget ?? initialModel?.contextBudget) === undefined
        ? {}
        : { contextBudget: options.contextBudget ?? initialModel!.contextBudget! }),
      ...(options.compactionStrategy === undefined
        ? {}
        : { compactionStrategy: options.compactionStrategy }),
      ...(options.autoCompactionStrategies === undefined
        ? {}
        : { autoCompactionStrategies: options.autoCompactionStrategies }),
      autoCompactionMode,
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
      ...(options.goals === undefined ? {} : { goals: options.goals }),
      ...(subagents === false
        ? { subagents: false as const }
        : {
            subagents: {
              configuration: subagents.configuration,
              dataDirectory: subagents.dataDirectory ?? dataDirectory,
              // 没有声明 profile 的角色继承主会话模型与 reasoning effort。
              createRoleModel: (role) => (subagents.createModel ?? subagentCreateModel)(role)?.model,
              contextBudgetFor: (role) => (subagents.createModel ?? subagentCreateModel)(role)?.contextBudget,
            },
          }),
      ...(skillDirectories === false
        ? (options.skills === undefined ? { skills: false as const } : {})
        : { skillDirectories }),
    });
    return application;
  } catch (error) {
    try {
      await closeResources();
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

function resolveMaybeCodeSubagents(
  value: false | MaybeCodeSubagentConfigurationOptions | undefined,
  config: MayConfig,
): false | ResolvedSubagents {
  if (value === false) return false;
  if (value?.configuration !== undefined) return value as ResolvedSubagents;
  const resolved = resolveSubagentConfiguration(config);
  if (resolved === false) return false;
  return { ...(value ?? {}), configuration: resolved };
}

type ResolvedSubagents = MaybeCodeSubagentConfigurationOptions & {
  readonly configuration: MaybeCodeSubagentConfiguration;
};

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

export function resolveMaybeCodeAutoCompactionMode(
  config: MayConfig,
): MaybeCodeAutoCompactionMode {
  const value = config.apps?.[MAYBECODE_APPLICATION_ID]?.autoCompaction;
  if (value === undefined) return "prune-summary";
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MaybeCodeConfigError(
      "apps.maybecode.autoCompaction must be an object",
    );
  }
  const { mode, providerNative } = value as Record<string, unknown>;
  if (providerNative !== undefined && typeof providerNative !== "boolean") {
    throw new MaybeCodeConfigError(
      "apps.maybecode.autoCompaction.providerNative must be a boolean",
    );
  }
  if (mode === undefined) return providerNative === true ? "provider-native" : "prune-summary";
  if (mode !== "prune-summary" && mode !== "history-reference" && mode !== "provider-native") {
    throw new MaybeCodeConfigError(
      "apps.maybecode.autoCompaction.mode must be prune-summary, history-reference, or provider-native",
    );
  }
  return mode;
}

/** @deprecated Use resolveMaybeCodeAutoCompactionMode instead. */
export function resolveProviderNativeAutoCompaction(config: MayConfig): boolean {
  return resolveMaybeCodeAutoCompactionMode(config) === "provider-native";
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
