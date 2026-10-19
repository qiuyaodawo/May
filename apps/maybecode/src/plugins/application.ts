import type { AnyPlugin } from "@sortedyuan/plugin";
import type { ContextBudget } from "@sortedyuan/context";
import { InMemoryContextFactory } from "@sortedyuan/context";
import type { UserMessage } from "@sortedyuan/core";
import type { McpClientPool } from "@sortedyuan/mcp";
import { applicationHooks, contextBudgetFromModel, withDefaultCompactionThreshold } from "@sortedyuan/application";
import { services, type ModelInfo } from "@sortedyuan/plugin-services";
import { mcpService } from "@sortedyuan/plugin-mcp";
import { createModelPlugin } from "@sortedyuan/plugin-models";
import { createPermissionPlugin } from "@sortedyuan/plugin-permissions";
import { createSkillsPlugin } from "@sortedyuan/plugin-skills";
import { createContextPlugin, createToolsPlugin } from "@sortedyuan/plugin-runtime";
import { createGoalsPlugin, goalsService } from "@sortedyuan/plugin-goals";
import { createHistoryMemoryPlugin, historyMemoryService } from "@sortedyuan/plugin-history-memory";
import { createDelegationPlugin, createWorkspaceFilesPlugin, delegationService } from "@sortedyuan/plugin-delegation";
import { SkillRegistry } from "@sortedyuan/skills";
import type { MaybeCodeApplicationOptions } from "../application.js";
import { createCodingPermissionPolicy } from "../policy.js";
import { defaultMaybeCodeSkillDirectories } from "../skills.js";
import { type GitRequestController, gitRequestService, requestMainRunIds, startGitGoalRequest } from "../git-request.js";

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
    readonly gitRequest: GitRequestController;
    readonly instructions: string;
    readonly contextBudget?: ContextBudget;
    readonly instructionsSource?: () => string;
    readonly projectInstructionsSource?: () => string;
    readonly prepareInstructions?: () => Promise<void>;
  },
): MaybeCodePluginComposition {
  const { workspace, instructions, contextBudget } = environment;
  const autoMode = options.autoCompactionMode ??
    (options.providerNativeAutoCompaction === true ? "provider-native" : "prune-summary");
  let hasDelegation = false;
  let modelInfo: ModelInfo | undefined;
  let mcp: McpClientPool | undefined;
  const defaults: AnyPlugin[] = [
    createModelPlugin({ create: () => {
      if (options.model === undefined) throw new TypeError("MaybeCode requires a Model or an application Model plugin");
      return options.model;
    }, ...(options.modelInfo === undefined ? {} : { info: options.modelInfo }) }),
    createPermissionPlugin({ create: () => createCodingPermissionPolicy({
      ...(options.permissionPolicy === undefined ? {} : { policy: options.permissionPolicy }),
      ...(options.permissionModeSource === undefined ? {} : { mode: options.permissionModeSource }),
      ...(options.gitWorkspace?.readOnly === true ? { readOnly: true } : {}),
      ...(options.permissionRuleStore === undefined ? {} : { persistent: { workspace, scopeId: options.permissionScopeId ?? `maybecode:${workspace}:main` } }),
    }) }),
    createContextPlugin({ create: () => options.contextFactory ?? new InMemoryContextFactory() }),
    createWorkspaceFilesPlugin({ workspace, defaultTools: options.tools === undefined }),
    createHistoryMemoryPlugin({
      mode: autoMode,
      budget: model => withDefaultCompactionThreshold(options.contextBudget ?? contextBudgetFromModel(model)),
      ...(options.contextSummarizer === undefined ? {} : { summarizer: options.contextSummarizer }),
      ...(options.compactionStrategy === undefined ? {} : { compactionStrategy: options.compactionStrategy }),
      ...(options.autoCompactionStrategies === undefined ? {} : { autoCompactionStrategies: options.autoCompactionStrategies }),
    }),
  ];
  if (options.skills !== false) defaults.push(createSkillsPlugin({
    create: () => options.skills || SkillRegistry.discover(
      options.skillDirectories ?? defaultMaybeCodeSkillDirectories(workspace, false),
    ),
  }));
  if (options.toolSource !== undefined) defaults.push(createToolsPlugin({
    id: "maybecode.additional-tools", create: () => options.toolSource!,
  }));
  if (options.goals !== false) defaults.push(createGoalsPlugin({
    validateBudget: budget => {
      if (budget.maxTotalTokens !== undefined && (autoMode === "provider-native" || options.contextSummarizer !== undefined || options.autoCompactionStrategies !== undefined || options.compactionStrategy !== undefined)) {
        throw new Error("Goal token budgets require built-in prune-summary or history-reference compaction with the metered model");
      }
    },
    createAgent: application => {
      const host = hasDelegation ? application.getService(delegationService).get() : undefined;
      const completed = options.onGitCheckpoint ?? (() => {});
      return {
        sessionId: application.sessionId,
        get isRunning() { return application.isRunning || host?.isRunning === true; },
        submit: plan => startGitGoalRequest(environment.gitRequest, application.sessionId,
          () => host ? host.start({ ...plan, record: requestRecord(plan.input) }, "submit") : application.submit(plan), completed,
          runId => application.saveBranchPosition(runId, { allowYielded: true }),
          async runId => (await application.branchPositions()).find(position => position.runId === runId)?.positionSeq,
          async firstRunId => requestMainRunIds(await application.history(), firstRunId)),
        continue: plan => startGitGoalRequest(environment.gitRequest, application.sessionId,
          () => host ? host.start({ ...plan, input: "", record: "Continue the active goal" }, "continue") : application.continue(plan), completed,
          runId => application.saveBranchPosition(runId, { allowYielded: true }),
          async runId => (await application.branchPositions()).find(position => position.runId === runId)?.positionSeq,
          async firstRunId => requestMainRunIds(await application.history(), firstRunId)),
      };
    },
  }));
  if (options.subagents !== false) defaults.push(createDelegationPlugin({
    workspace, instructions,
    ...(environment.instructionsSource === undefined ? {} : { instructionsSource: environment.instructionsSource }),
    ...(environment.projectInstructionsSource === undefined ? {} : { projectInstructionsSource: environment.projectInstructionsSource }),
    ...(environment.prepareInstructions === undefined ? {} : { prepareInstructions: environment.prepareInstructions }),
    permissionModeSource: () => options.gitWorkspace?.readOnly ? "read-only" : options.permissionModeSource?.() ?? (options.permissionPolicy ? "custom" : "default"),
    ...(options.subagents ?? {}),
    beforeToolExecute: environment.gitRequest.beforeToolExecute,
    ...(options.toolSource === undefined ? {} : { toolSource: options.toolSource }),
    ...(contextBudget === undefined ? {} : { contextBudget }),
    ...(options.compactionStrategy === undefined ? {} : { compactionStrategy: options.compactionStrategy }),
    autoCompactionMode: autoMode,
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    traceAttributes: { "may.agent.name": "maybecode" },
  }));
  const plugins = composeMaybeCodePlugins(defaults, options.plugins ?? []);
  const hasGoals = plugins.some(plugin => plugin.provides?.some(service => service.id === goalsService.id && service.scope === goalsService.scope));
  hasDelegation = plugins.some(plugin => plugin.provides?.some(service => service.id === delegationService.id && service.scope === delegationService.scope));
  plugins.push({
    id: "maybecode.product", version: "1.0.0", scope: "application",
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
  return { plugins, hasGoals, hasDelegation, get modelInfo() { return modelInfo; }, get mcp() { return mcp; } };
}

export function composeMaybeCodePlugins(defaults: readonly AnyPlugin[], selected: readonly AnyPlugin[]): AnyPlugin[] {
  const ids = new Set(selected.map(plugin => plugin.id));
  const services = new Set(selected.flatMap(plugin => plugin.provides?.map(service => `${service.scope}:${service.id}`) ?? []));
  return [...defaults.filter(plugin => !ids.has(plugin.id) && !plugin.provides?.some(service => services.has(`${service.scope}:${service.id}`))), ...selected];
}

/** 请求的持久文本记录；原始输入仍然保存在 Session 中。 */
export function requestRecord(input: string | UserMessage): string {
  const text = typeof input === "string"
    ? input
    : input.content.filter((part) => part.type === "text").map((part) => part.text).join("");
  return text.trim() === "" ? "Request without text content" : text;
}
