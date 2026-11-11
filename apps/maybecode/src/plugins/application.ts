import type { AnyPlugin } from "@sortedyuan/may/plugin";
import type { CodingExecutionEnvironment, WorkspaceFileGuard } from "@sortedyuan/coding-tools";
import { createLspTools, type LanguageServerManager } from "@sortedyuan/lsp-tools";
import type { ContextBudget } from "@sortedyuan/may/context";
import { InMemoryContextFactory } from "@sortedyuan/may/context";
import { omitUndefined, type Context, type Tool, type UserMessage } from "@sortedyuan/may/core";
import type { McpClientPool } from "@sortedyuan/mcp";
import { applicationHooks, contextBudgetFromModel, withDefaultCompactionThreshold } from "@sortedyuan/may";
import { services, type ModelInfo } from "@sortedyuan/may/services";
import { mcpService } from "@sortedyuan/mcp/plugin";
import { createModelPlugin } from "@sortedyuan/may/services/models";
import { createPermissionPlugin } from "@sortedyuan/may/services/permissions";
import { createSkillsPlugin } from "@sortedyuan/may/services/skills";
import { createContextPlugin, createContextWrapperPlugin, createToolsPlugin } from "@sortedyuan/may/services/runtime";
import { createGoalsPlugin, goalsService } from "@sortedyuan/may/goals/plugin";
import { createHistoryMemoryPlugin, historyMemoryService } from "@sortedyuan/may/history-memory";
import {
  createDelegationPlugin,
  createWorkspaceFilesPlugin,
  delegationService,
  workspaceFilesService,
} from "@sortedyuan/coordination/delegation";
import { SkillRegistry } from "@sortedyuan/may/skills";
import type { MaybeCodeApplicationOptions } from "../application.js";
import { createCodingPermissionPolicy } from "../policy.js";
import { defaultMaybeCodeSkillDirectories } from "../skills.js";
import {
  type GitRequestController,
  gitRequestService,
  requestMainRunIds,
  startGitGoalRequest,
} from "../git-request.js";

export interface MaybeCodePluginComposition {
  readonly plugins: readonly AnyPlugin[];
  readonly hasGoals: boolean;
  readonly hasDelegation: boolean;
  readonly modelInfo: ModelInfo | undefined;
  readonly mcp: McpClientPool | undefined;
}

export function createMaybeCodePlugins(
  options: MaybeCodeApplicationOptions,
  environment: {
    readonly workspace: string;
    readonly execution: CodingExecutionEnvironment;
    readonly lsp?: LanguageServerManager;
    readonly onContext?: (context: Context) => void;
    readonly gitRequest: GitRequestController;
    readonly instructions: string;
    readonly contextBudget?: ContextBudget;
    readonly instructionsSource?: () => string;
    readonly projectInstructionsSource?: () => string;
    readonly prepareInstructions?: () => Promise<void>;
  },
): MaybeCodePluginComposition {
  const { workspace, instructions, contextBudget } = environment;
  const autoMode = options.autoCompactionMode ?? "prune-summary";
  let searchTools: readonly Tool[] = [];
  const lsp = environment.lsp;
  const lspNames = lsp ? createLspTools(lsp).map((tool) => tool.name) : [];
  const toolFactories: Record<string, (guard: WorkspaceFileGuard) => Tool> = {};
  if (lsp)
    for (const name of lspNames)
      toolFactories[name] = (guard) => createLspTools(lsp, { guard }).find((tool) => tool.name === name)!;
  if (options.toolSource || options.searchToolsForModel)
    toolFactories.web_search = () => {
      const tool = [...searchTools, ...(options.toolSource?.() ?? [])].find((item) => item.name === "web_search");
      if (!tool) throw new Error("Host web_search is unavailable for the current model");
      return tool;
    };
  let hasDelegation = false;
  let modelInfo: ModelInfo | undefined;
  let mcp: McpClientPool | undefined;
  const defaults: AnyPlugin[] = [
    createModelPlugin({
      create: () => {
        if (options.model === undefined)
          throw new TypeError("MaybeCode requires a Model or an application Model plugin");
        return options.model;
      },
      ...omitUndefined({ info: options.modelInfo }),
    }),
    createPermissionPlugin({
      create: () =>
        createCodingPermissionPolicy({
          ...omitUndefined({ policy: options.permissionPolicy, mode: options.permissionModeSource }),
          ...(options.gitWorkspace?.readOnly === true ? { readOnly: true } : {}),
          ...(options.permissionRuleStore === undefined
            ? {}
            : { persistent: { workspace, scopeId: options.permissionScopeId ?? `maybecode:${workspace}:main` } }),
        }),
    }),
    createContextPlugin({ create: () => options.contextFactory ?? new InMemoryContextFactory() }),
    createContextWrapperPlugin({
      id: "maybecode.context-protection",
      create: () => (factory) => ({
        async create(input) {
          const managed = await factory.create(input);
          environment.onContext?.(managed.context);
          return managed;
        },
      }),
    }),
    createWorkspaceFilesPlugin({
      workspace,
      defaultTools: options.tools === undefined,
      execution: environment.execution,
      toolFactories,
      ...omitUndefined({
        fetch: options.fetch,
        fileFeedback: options.lsp && options.lsp.editDiagnostics !== false ? lsp?.fileFeedback : undefined,
      }),
    }),
    createHistoryMemoryPlugin({
      mode: autoMode,
      budget: (model) => withDefaultCompactionThreshold(options.contextBudget ?? contextBudgetFromModel(model)),
      ...omitUndefined({
        summarizer: options.contextSummarizer,
        compactionStrategy: options.compactionStrategy,
        autoCompactionStrategies: options.autoCompactionStrategies,
      }),
    }),
  ];
  const createSearchTools = options.searchToolsForModel;
  if (createSearchTools)
    defaults.push(
      createToolsPlugin({
        id: "maybecode.search",
        create: async () => {
          searchTools = await createSearchTools(options.modelInfo);
          return () => searchTools;
        },
      }),
    );
  if (lsp)
    defaults.push(
      createToolsPlugin({
        id: "maybecode.lsp",
        requires: [{ service: workspaceFilesService }],
        create: (context) => {
          const tools = context.get(workspaceFilesService).create({ names: lspNames, requireRead: false }).tools;
          return () => tools;
        },
      }),
    );
  if (options.skills !== false)
    defaults.push(
      createSkillsPlugin({
        create: () =>
          options.skills ||
          SkillRegistry.discover(options.skillDirectories ?? defaultMaybeCodeSkillDirectories(workspace, false)),
      }),
    );
  if (options.toolSource !== undefined)
    defaults.push(
      createToolsPlugin({
        id: "maybecode.additional-tools",
        create: () => options.toolSource!,
      }),
    );
  if (options.goals !== false)
    defaults.push(
      createGoalsPlugin({
        validateBudget: (budget) => {
          if (
            budget.maxTotalTokens !== undefined &&
            (autoMode === "provider-native" ||
              options.contextSummarizer !== undefined ||
              options.autoCompactionStrategies !== undefined ||
              options.compactionStrategy !== undefined)
          ) {
            throw new Error(
              "Goal token budgets require built-in prune-summary or history-reference compaction with the metered model",
            );
          }
        },
        createAgent: (application) => {
          const host = hasDelegation ? application.getService(delegationService).get() : undefined;
          const completed = options.onGitCheckpoint ?? (() => {});
          return {
            sessionId: application.sessionId,
            get isRunning() {
              return application.isRunning || host?.isRunning === true;
            },
            submit: (plan) =>
              startGitGoalRequest(
                environment.gitRequest,
                application.sessionId,
                () =>
                  host
                    ? host.start({ ...plan, record: requestRecord(plan.input) }, "submit")
                    : application.submit(plan),
                completed,
                (runId) => application.saveBranchPosition(runId, { allowYielded: true }),
                async (runId) =>
                  (await application.branchPositions()).find((position) => position.runId === runId)?.positionSeq,
                async (firstRunId) => requestMainRunIds(await application.history(), firstRunId),
              ),
            continue: (plan) =>
              startGitGoalRequest(
                environment.gitRequest,
                application.sessionId,
                () =>
                  host
                    ? host.start({ ...plan, input: "", record: "Continue the active goal" }, "continue")
                    : application.continue(plan),
                completed,
                (runId) => application.saveBranchPosition(runId, { allowYielded: true }),
                async (runId) =>
                  (await application.branchPositions()).find((position) => position.runId === runId)?.positionSeq,
                async (firstRunId) => requestMainRunIds(await application.history(), firstRunId),
              ),
          };
        },
      }),
    );
  if (options.subagents !== false)
    defaults.push(
      createDelegationPlugin({
        workspace,
        execution: environment.execution,
        ...omitUndefined({ fetch: options.fetch }),
        instructions,
        requestRecording: options.requestRecording ?? "required",
        providerBodyRecording: options.providerBodyRecording ?? false,
        ...omitUndefined({
          instructionsSource: environment.instructionsSource,
          projectInstructionsSource: environment.projectInstructionsSource,
          prepareInstructions: environment.prepareInstructions,
        }),
        permissionModeSource: () =>
          options.gitWorkspace?.readOnly
            ? "read-only"
            : (options.permissionModeSource?.() ?? (options.permissionPolicy ? "custom" : "default")),
        ...(options.subagents ?? {}),
        beforeToolExecute: environment.gitRequest.beforeToolExecute,
        ...omitUndefined({
          toolSource:
            options.toolSource === undefined
              ? undefined
              : () => [...options.toolSource!()].filter((tool) => tool.name !== "web_search"),
          contextBudget,
          compactionStrategy: options.compactionStrategy,
          maxSteps: options.maxSteps,
        }),
        autoCompactionMode: autoMode,
        traceAttributes: { "may.agent.name": "maybecode" },
      }),
    );
  const plugins = composeMaybeCodePlugins(defaults, options.plugins ?? []);
  const hasGoals = plugins.some((plugin) =>
    plugin.provides?.some((service) => service.id === goalsService.id && service.scope === goalsService.scope),
  );
  hasDelegation = plugins.some((plugin) =>
    plugin.provides?.some(
      (service) => service.id === delegationService.id && service.scope === delegationService.scope,
    ),
  );
  plugins.push({
    id: "maybecode.product",
    version: "1.0.0",
    scope: "application",
    provides: [gitRequestService],
    requires: [
      { service: historyMemoryService },
      ...(hasGoals ? [{ service: goalsService }] : []),
      ...(hasDelegation ? [{ service: delegationService }] : []),
    ],
    optional: [{ service: services.modelInfo }, { service: mcpService }],
    requiresHooks: [applicationHooks.created],
    setup(context) {
      context.provide(gitRequestService, environment.gitRequest);
      context.on(applicationHooks.created, () => {
        modelInfo = context.optional(services.modelInfo);
        mcp = context.optional(mcpService);
      });
    },
  });
  return {
    plugins,
    hasGoals,
    hasDelegation,
    get modelInfo() {
      return modelInfo;
    },
    get mcp() {
      return mcp;
    },
  };
}

export function composeMaybeCodePlugins(defaults: readonly AnyPlugin[], selected: readonly AnyPlugin[]): AnyPlugin[] {
  const ids = new Set(selected.map((plugin) => plugin.id));
  const services = new Set(
    selected.flatMap((plugin) => plugin.provides?.map((service) => `${service.scope}:${service.id}`) ?? []),
  );
  return [
    ...defaults.filter(
      (plugin) =>
        !ids.has(plugin.id) && !plugin.provides?.some((service) => services.has(`${service.scope}:${service.id}`)),
    ),
    ...selected,
  ];
}

/** 请求的持久文本记录；原始输入仍然保存在 Session 中。 */
export function requestRecord(input: string | UserMessage): string {
  const text =
    typeof input === "string"
      ? input
      : input.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
  return text.trim() === "" ? "Request without text content" : text;
}
