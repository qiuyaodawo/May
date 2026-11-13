import { realpath } from "node:fs/promises";
import { configuredSearchTools, searchStatus } from "./search.js";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadMayConfig } from "@sortedyuan/may/config";
import { omitUndefined, resolveRunBudget, type Tool } from "@sortedyuan/may/core";
import { createMcpModelSampler, type McpHostRequestContext, type McpClientPool } from "@sortedyuan/mcp";
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
  withModelRetry,
} from "@sortedyuan/providers";
import { FileSessionStore } from "@sortedyuan/may/session/file-store";
import { FilePermissionRuleStore } from "@sortedyuan/may/permissions/file-store";
import { userInfo } from "node:os";

import { FileSessionCatalog } from "@sortedyuan/may/session/catalog";
import { MaybeCodeConfigError } from "./errors.js";
import type { ConfiguredMaybeCodeDependencies, OpenConfiguredMaybeCodeOptions } from "./configured-options.js";
import {
  createContextBudget,
  getDefaultMaybeCodeDataDirectory,
  resolveDefaultModelPersistence,
  resolveMaybeCodeAutoCompactionMode,
  resolveMaybeCodeGit,
  resolveMaybeCodeMcp,
  resolveMaybeCodeObservability,
  resolveMaybeCodeRecording,
  resolveMaybeCodeRetry,
  resolveMaybeCodeSubagents,
  resolveWorkspace,
} from "./configured-resolvers.js";
import { createMaybeCodeModel, selectMaybeCodeModel, type SelectedMaybeCodeModel } from "./model.js";
import { resolveMaybeCodeInstructionsDirectory } from "./instructions.js";
import { readMaybeCodeSettings } from "./settings.js";
import { MaybeCodeWorkspace } from "./workspace.js";
import type { MaybeCodeModelConfiguration } from "./workspace.js";
import { PluginHost, loadPluginModules, type AnyPlugin, type ServiceToken } from "@sortedyuan/may/plugin";
import { resolveMaybeCodeSkillDirectories } from "./skills.js";
import { parsePermissionMode } from "./policy.js";
import type { MaybeCodeSubagentRole } from "@sortedyuan/coordination/delegation/configuration";

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
    if (
      settings.webSearch === false &&
      ((selected.adapter === "openai-chat-completions" && selected.model === "gpt-5-search-api") ||
        selected.capabilities?.fields?.["serverTools.alwaysSearches"] === true ||
        selected.providerConfig.capabilities?.fields?.["serverTools.alwaysSearches"] === true)
    )
      throw new MaybeCodeConfigError("This model searches on every reply and conflicts with webSearch: false");
    const mergedOptions = { ...selected.options, ...runtimeOptions };
    const { webSearch: _webSearch, ...withoutSearch } = mergedOptions;
    const selection: SelectedMaybeCodeModel = {
      ...selected,
      options:
        settings.webSearch === false
          ? ["deepseek-chat", "kimi-chat"].includes(selected.adapter)
            ? withoutSearch
            : { ...mergedOptions, webSearch: false }
          : mergedOptions,
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
        searchStatus: searchStatus(settings.webSearch, selection.adapter, selection.options, selection.model),
      },
      contextBudget,
    });
  };
  const initialModel = pluginModel ? undefined : configureModel(options.model);
  let searchTools: Promise<readonly Tool[]> | undefined;
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
          searchStatus: searchStatus(
            settings.webSearch,
            profile.adapter ?? provider.adapter,
            { ...provider.options, ...profile.options },
            profile.model,
          ),
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
      searchToolsForModel: async (info) => {
        if (pluginModel) return [];
        const selected = selectionFor(info?.profile ?? options.model);
        if (
          settings.webSearch === false ||
          (selected.options.webSearch !== undefined && selected.options.webSearch !== false)
        )
          return [];
        if (
          (selected.adapter === "openai-chat-completions" && selected.model === "gpt-5-search-api") ||
          selected.capabilities?.fields?.["serverTools.alwaysSearches"] === true ||
          selected.providerConfig.capabilities?.fields?.["serverTools.alwaysSearches"] === true
        )
          return [];
        if (settings.webSearch?.hostTool?.backend === "kimi-formula" && selected.adapter !== "kimi-chat") return [];
        return (searchTools ??= configuredSearchTools(config, settings.webSearch));
      },
      git,
      ...omitUndefined({
        execution: settings.execution,
        fetch: settings.fetch,
        lsp: settings.lsp,
        webSearch: settings.webSearch,
      }),
      dataDirectory,
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
