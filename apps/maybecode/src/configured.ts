import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  loadMayConfig,
  updateDefaultMayModel,
  type LoadMayConfigOptions,
  type MayConfig,
} from "@sortedyuan/may/config";
import type {
  ContextBudget,
  ContextCompactionStrategy,
  ContextFactory,
  ContextSummarizer,
} from "@sortedyuan/may/context";
import { omitUndefined, resolveRunBudget, type Model, type RunBudget } from "@sortedyuan/may/core";
import {
  type McpOAuthManager,
  type McpTaskJournal,
  createMcpModelSampler,
  type McpHostRequestContext,
  validateMcpServerOptions,
  type McpClientPool,
  type McpServerBaseOptions,
  type McpServerOptions,
  type McpOAuthOptions,
  type OpenMcpClientPoolOptions,
} from "@sortedyuan/mcp";
import { mcpHostService, mcpService, type McpPluginOptions } from "@sortedyuan/mcp/plugin";
import {
  createSharedObservabilityPlugin,
  observabilityHostService,
  observabilityService,
} from "@sortedyuan/observability/plugin";
import { services } from "@sortedyuan/may/services";
import { createMaybeCodeResourcePlugins, createMaybeCodeSharedPlugins } from "./plugins/resources.js";
import {
  createModelCapabilityResolver,
  createBuiltinProviderAdapterRegistry,
  type ModelCapabilityResolver,
  type ProviderAdapterRegistry,
  withModelRetry,
  type RetryingModelOptions,
} from "@sortedyuan/providers";
import { FileSessionStore } from "@sortedyuan/may/session/file-store";
import { FilePermissionRuleStore } from "@sortedyuan/may/permissions/file-store";
import { userInfo } from "node:os";

import { FileSessionCatalog } from "@sortedyuan/may/session/catalog";
import { MaybeCodeConfigError } from "./errors.js";
import {
  createMaybeCodeModel,
  selectMaybeCodeModel,
  type MaybeCodeModelSelector,
  type SelectedMaybeCodeModel,
} from "./model.js";
import { resolveMaybeCodeInstructionsDirectory } from "./instructions.js";
import { readMaybeCodeSettings, type MaybeCodeSettings } from "./settings.js";
import { MaybeCodeWorkspace } from "./workspace.js";
import type { MaybeCodeAutoCompactionMode } from "./controller.js";
import type { MaybeCodeModelConfiguration } from "./workspace.js";
import type { ProjectGitWorkspaceOptions } from "@sortedyuan/may/application/git-workspace";
import type { SkillRegistry } from "@sortedyuan/may/skills";
import { PluginHost, loadPluginModules, type AnyPlugin, type ServiceToken } from "@sortedyuan/may/plugin";
import { resolveMaybeCodeSkillDirectories } from "./skills.js";
import { parsePermissionMode, type MaybeCodePermissionMode } from "./policy.js";
import {
  resolveSubagentConfiguration,
  type MaybeCodeSubagentConfiguration,
  type MaybeCodeSubagentRole,
} from "@sortedyuan/coordination/delegation/configuration";

/** @experimental */
export interface OpenConfiguredMaybeCodeOptions extends MaybeCodeModelSelector {
  readonly git?: false | Omit<ProjectGitWorkspaceOptions, "workspace">;
  readonly plugins?: readonly AnyPlugin[];
  readonly permissionMode?: MaybeCodePermissionMode;
  readonly delegationNotifications?: boolean;
  readonly persistentRules?: boolean;
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

/** @experimental */
export interface MaybeCodeSubagentConfigurationOptions {
  /** 角色、限制与额度；缺省时注册 worker 角色。 */
  readonly configuration?: MaybeCodeSubagentConfiguration;
  /** 每次请求的协调记录根目录。 */
  readonly dataDirectory?: string;
  /** 声明了自己 profile 的角色使用的模型配置工厂。 */
  readonly createModel?: (role: MaybeCodeSubagentRole) => MaybeCodeModelConfiguration;
}
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

/** @experimental */
export interface ConfiguredMaybeCodeDependencies {
  readonly loadConfig?: (options?: LoadMayConfigOptions) => Promise<MayConfig>;
  readonly createModel?: (selection: SelectedMaybeCodeModel) => Model;
  readonly adapterRegistry?: ProviderAdapterRegistry;
  readonly capabilityResolver?: ModelCapabilityResolver;
  readonly persistDefaultModel?: (profile: string) => Promise<void>;
  readonly openMcp?: (options: OpenMcpClientPoolOptions) => Promise<McpClientPool>;
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

/** @experimental */
export async function openConfiguredMaybeCode(
  options: OpenConfiguredMaybeCodeOptions = {},
  dependencies: ConfiguredMaybeCodeDependencies = {},
): Promise<MaybeCodeWorkspace> {
  const workspace = await resolveWorkspace(options.workspace ?? process.cwd());
  const loadConfig = dependencies.loadConfig ?? loadMayConfig;
  const config = await loadConfig(omitUndefined({ path: options.configPath }));
  const settings = readMaybeCodeSettings(config);
  const retry = options.retry ?? resolveMaybeCodeRetry(config);
  const plugins = options.plugins ?? (await loadPluginModules(settings.plugins ?? [], config.path));
  const provided = (service: ServiceToken<unknown>) =>
    plugins.some((plugin) =>
      plugin.provides?.some((candidate) => candidate.id === service.id && candidate.scope === service.scope),
    );
  const pluginModel = provided(services.model);
  const { requestRecording, providerBodyRecording } = resolveMaybeCodeRecording(config);
  const delegationNotifications = options.delegationNotifications ?? settings.delegationNotifications ?? false;
  const git = options.git ?? resolveMaybeCodeGit(config);
  const permissionMode =
    options.permissionMode === undefined
      ? (settings.permissionMode ?? "default")
      : parsePermissionMode(options.permissionMode);
  const persistentRules = options.persistentRules ?? settings.persistentRules ?? false;
  const skillDirectories = options.skillDirectories ?? resolveMaybeCodeSkillDirectories(config, workspace);
  const runBudget = resolveRunBudget(options.runBudget ?? settings.runBudget);
  const capabilityResolver = dependencies.capabilityResolver ?? createModelCapabilityResolver();
  const adapterRegistry =
    dependencies.adapterRegistry ?? createBuiltinProviderAdapterRegistry({ resolver: capabilityResolver });
  const selectionFor = (profile?: string): SelectedMaybeCodeModel =>
    selectMaybeCodeModel(config, omitUndefined({ model: profile }));
  const configureModel = (
    profile?: string,
    runtimeOptions: Readonly<Record<string, unknown>> = {},
  ): MaybeCodeModelConfiguration => {
    const selected = selectionFor(profile);
    const selection: SelectedMaybeCodeModel = {
      ...selected,
      options: { ...selected.options, ...runtimeOptions },
    };
    const baseModel =
      dependencies.createModel === undefined
        ? createMaybeCodeModel(selection, adapterRegistry)
        : dependencies.createModel(selection);
    const model = retry === false ? baseModel : withModelRetry(baseModel, retry);
    const contextBudget = options.contextBudget ?? createContextBudget(model, selection);
    return omitUndefined({
      model,
      modelInfo: {
        profile: selection.profile,
        provider: selection.provider,
        adapter: selection.adapter,
        model: selection.model,
      },
      contextBudget,
    });
  };
  const initialModel = pluginModel ? undefined : configureModel(options.model);
  const modelProfiles = pluginModel
    ? []
    : Object.entries(config.models).map(([name, profile]) => {
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
  const instructionsDirectory =
    options.instructions === undefined ? resolveMaybeCodeInstructionsDirectory(config) : undefined;
  const autoCompactionMode = options.autoCompactionMode ?? resolveMaybeCodeAutoCompactionMode(config);
  const dataDirectory = resolve(options.dataDirectory ?? getDefaultMaybeCodeDataDirectory());
  const observabilityOptions =
    provided(observabilityService) || provided(services.tracer)
      ? false
      : (options.observability ?? resolveMaybeCodeObservability(config));
  const subagents = resolveMaybeCodeSubagents(options.subagents, settings);
  const subagentCreateModel = (role: MaybeCodeSubagentRole): MaybeCodeModelConfiguration | undefined =>
    role.model === undefined
      ? initialModel
      : configureModel(role.model, role.reasoningEffort === undefined ? {} : { reasoningEffort: role.reasoningEffort });
  let mcp: McpClientPool | undefined;
  let resourceHost: PluginHost | undefined;
  const workspaceResourceHosts = new Map<string, PluginHost>();
  const workspacePlugins = new Map<string, readonly AnyPlugin[]>();
  const permissionStores = new Map<string, FilePermissionRuleStore>();
  const permissionsFor = async (directory: string) => {
    if (!persistentRules) return {};
    const root = await realpath(directory);
    let store = permissionStores.get(root);
    if (!store) {
      store = await FilePermissionRuleStore.open({ path: join(root, ".may", "permission-rules.json") });
      permissionStores.set(root, store);
    }
    return { permissionRuleStore: store, permissionScopeId: `maybecode:${userInfo().username}:${root}:main` };
  };
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
    const next = provided(mcpService)
      ? false
      : options.mcp === undefined
        ? resolveMaybeCodeMcp(config, nextWorkspace)
        : options.mcp === false
          ? false
          : {
              ...options.mcp,
              servers: options.mcp.servers.map((server) => {
                if (server.transport === "streamable-http") return server;
                const source = resolve(workspace, server.cwd ?? ".");
                const path = relative(workspace, source);
                const inside =
                  path === "" ||
                  (path !== ".." && !path.startsWith("..\\") && !path.startsWith("../") && !isAbsolute(path));
                return { ...server, cwd: inside ? resolve(nextWorkspace, path) : source };
              }),
            };
    if (next === false) return false;
    const tracer = resourceHost?.provides(observabilityHostService)
      ? resourceHost.get(observabilityHostService).tracer
      : undefined;
    return {
      servers: next.servers,
      ...omitUndefined({ taskJournal: next.taskJournal, oauth: next.oauth, tracer, open: dependencies.openMcp }),
      enableInteractions: options.mcpInteractions === true,
      hostServices: {
        roots: async (context) => {
          checkHostOwner(context);
          return [{ uri: pathToFileURL(application!.workspace).href, name: "MaybeCode workspace" }];
        },
        ...(pluginModel
          ? {}
          : {
              sampling: createMcpModelSampler((maxTokens, context) => {
                checkHostOwner(context);
                const selected = selectionFor(application!.application.modelInfo?.profile);
                const selection = {
                  ...selected,
                  options: { ...selected.options, maxTokens, maxOutputTokens: maxTokens },
                };
                // sampling 使用独立 provider 实例和本次调用的模型预算。
                const model =
                  dependencies.createModel === undefined
                    ? createMaybeCodeModel(selection, dependencies.adapterRegistry)
                    : dependencies.createModel(selection);
                return { model, name: selected.model };
              }),
            }),
      },
      traceAttributes: { "may.agent.name": "maybecode" },
    };
  };
  const closeResources = async () => {
    const results = await Promise.allSettled([...workspaceResourceHosts.values()].map((host) => host.close()));
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    try {
      await resourceHost?.close();
    } catch (error) {
      failures.push(error);
    }
    for (const store of permissionStores.values()) {
      try {
        await store.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, "MaybeCode configured resources failed to close");
  };

  try {
    const resourcePlugins = createMaybeCodeResourcePlugins({
      dataDirectory,
      observability: observabilityOptions,
      mcp: mcpForWorkspace(workspace),
    });
    resourceHost = await PluginHost.create({ plugins: resourcePlugins });
    if (resourceHost.provides(mcpHostService)) mcp = resourceHost.get(mcpHostService);
    const observability = resourceHost.provides(observabilityHostService)
      ? resourceHost.get(observabilityHostService)
      : undefined;
    const applicationPlugins = createMaybeCodeSharedPlugins(resourceHost, plugins);
    workspacePlugins.set(workspace, applicationPlugins);
    application = await MaybeCodeWorkspace.open({
      git,
      ...omitUndefined({ execution: settings.execution, fetch: settings.fetch }),
      ...(await permissionsFor(workspace)),
      configureWorkspace: async (nextWorkspace) => {
        const directories = options.skillDirectories ?? resolveMaybeCodeSkillDirectories(config, nextWorkspace);
        let configuredPlugins = workspacePlugins.get(nextWorkspace);
        if (configuredPlugins === undefined) {
          const nextHost = await PluginHost.create({
            plugins: createMaybeCodeResourcePlugins({
              dataDirectory,
              observability: false,
              mcp: mcpForWorkspace(nextWorkspace),
            }),
          });
          workspaceResourceHosts.set(nextWorkspace, nextHost);
          configuredPlugins = createMaybeCodeSharedPlugins(nextHost, [
            ...(observability === undefined ? [] : [createSharedObservabilityPlugin(observability)]),
            ...plugins,
          ]);
          workspacePlugins.set(nextWorkspace, configuredPlugins);
        }
        return {
          plugins: configuredPlugins,
          ...(await permissionsFor(nextWorkspace)),
          ...(directories === false ? { skills: false } : { skillDirectories: directories }),
        };
      },
      permissionMode,
      requestRecording,
      providerBodyRecording,
      delegationNotifications,
      workspace,
      ...(initialModel === undefined ? {} : { model: initialModel.model, modelInfo: initialModel.modelInfo }),
      modelProfiles,
      ...(pluginModel
        ? {}
        : {
            createModelConfiguration: (profile: string, runtimeOptions?: Readonly<Record<string, unknown>>) =>
              configureModel(profile, runtimeOptions),
            resolveModelCapabilities: async (profile: string, options?: { readonly refresh?: boolean }) =>
              capabilityResolver.resolve(selectionFor(profile), options),
          }),
      ...resolveDefaultModelPersistence(config, dependencies),
      store: new FileSessionStore(join(dataDirectory, "sessions")),
      plugins: applicationPlugins,
      catalog: new FileSessionCatalog(join(dataDirectory, "catalog.json")),
      closeOwnedResources: closeResources,
      autoCompactionMode,
      runBudget,
      ...omitUndefined({
        mcp,
        sessionId: options.sessionId,
        autoResume: options.autoResume,
        contextFactory: options.contextFactory,
        contextBudget: options.contextBudget ?? initialModel?.contextBudget,
        compactionStrategy: options.compactionStrategy,
        autoCompactionStrategies: options.autoCompactionStrategies,
        contextSummarizer: options.contextSummarizer,
        instructions: options.instructions,
        instructionsDirectory,
        maxSteps: options.maxSteps,
        skills: options.skills,
        goals: options.goals,
      }),
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
        ? options.skills === undefined
          ? { skills: false as const }
          : {}
        : { skillDirectories }),
    });
    return application;
  } catch (error) {
    try {
      await closeResources();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "MaybeCode failed to open and release configured resources");
    }
    throw error;
  }
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

function resolveMaybeCodeSubagents(
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

function createContextBudget(model: Model, selection: SelectedMaybeCodeModel): ContextBudget | undefined {
  const contextWindowTokens = model.limits?.contextWindowTokens ?? selection.limits?.contextWindowTokens;
  const outputReserveTokens = model.limits?.maxOutputTokens ?? selection.limits?.maxOutputTokens;
  if (contextWindowTokens === undefined && outputReserveTokens === undefined) {
    return undefined;
  }
  return omitUndefined({ contextWindowTokens, outputReserveTokens });
}

async function resolveWorkspace(workspace: string): Promise<string> {
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
