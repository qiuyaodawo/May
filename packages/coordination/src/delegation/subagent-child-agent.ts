import { applicationHooks, applicationServices, defineAgent } from "@sortedyuan/may";
import { definePlugin } from "@sortedyuan/may/plugin";
import { omitUndefined } from "@sortedyuan/may/core";
import {
  InMemoryContextFactory,
  ModelContextCompactionStrategy,
  PruneOldToolResultsStrategy,
  SummaryTailStrategy,
  type ContextCompactionStrategy,
} from "@sortedyuan/may/context";
import { runtimeHooks, resolveRunBudget, type Model } from "@sortedyuan/may/core";
import { codingRuntimeInstructions, getShellToolInfo } from "@sortedyuan/coding-tools";
import { createApplicationAgent, type CoordinationAgent, type CoordinationTask } from "../index.js";
import type { AutoCompactionMode as MaybeCodeAutoCompactionMode } from "@sortedyuan/may/history-memory";
import { subagentInstructions } from "./subagent-instructions.js";
import { SharedWorkspaceFileGuard } from "./subagent-files.js";
import { withRequestBudget } from "./subagent-budget.js";
import { HistoryReferenceMemory, createModelContextSummarizer } from "@sortedyuan/may/history-memory";
import type { MaybeCodeSubagentRole } from "./subagents.js";
import { SUBAGENT_DEFAULT_MAX_STEPS } from "./subagents.js";
import { VERSION } from "./subagent-constants.js";
import type { SubagentHostOptions } from "./subagent-host.js";
import type { SubagentRequest } from "./subagent-request.js";

/** 主会话与子 Agent 共用的自动压缩链构造。 */
function automaticCompactionStrategies(
  mode: MaybeCodeAutoCompactionMode,
  summary: ContextCompactionStrategy,
  historyReference: ContextCompactionStrategy,
  native: ContextCompactionStrategy | undefined,
): readonly ContextCompactionStrategy[] {
  switch (mode) {
    case "prune-summary":
      return [new PruneOldToolResultsStrategy(), summary];
    case "history-reference":
      return [historyReference];
    case "provider-native":
      if (native === undefined) throw new Error("This model does not support provider-native context compaction");
      return [native];
    default:
      throw new Error(`Unknown automatic compaction mode: ${String(mode)}`);
  }
}

export interface ChildAgentHost {
  readonly options: SubagentHostOptions;
  readonly activeRequest: () => SubagentRequest | undefined;
  readonly roleModel: (role: MaybeCodeSubagentRole) => Model;
  readonly depthOf: (task: CoordinationTask) => number;
}

export function createChildAgent(role: MaybeCodeSubagentRole, host: ChildAgentHost): CoordinationAgent {
  const options = host.options;
  const memories = new Map<string, HistoryReferenceMemory>();
  const scoped = createApplicationAgent({
    version: VERSION,
    store: options.store,
    delegation: role.delegateTo.length > 0,
    onOpen: (application, execution) => memories.get(execution.task.sessionId)!.attach(application),
    definition: ({ tools, execution }) => {
      const request = host.activeRequest();
      if (request === undefined) throw new Error("The sub-agent request is no longer active");
      const coding = role.tools;
      const files = (
        options.fileGuard ??
        new SharedWorkspaceFileGuard(
          options.workspace,
          omitUndefined({ execution: options.execution, fetch: options.fetch }),
        )
      ).create(
        omitUndefined({
          names: coding,
          requireRead: true,
          files: execution.task.files,
        }),
      );
      const contextBudget =
        role.model === undefined ? options.contextBudget : (options.contextBudgetFor?.(role) ?? options.contextBudget);
      const roleBudget = resolveRunBudget(role.runBudget, options.configuration.runBudget);
      // 角色预算与子 Agent 预算取较小的值；两者都省略 maxSteps 时用子 Agent 默认值。
      const maxSteps = roleBudget.maxSteps ?? options.maxSteps ?? SUBAGENT_DEFAULT_MAX_STEPS;
      const childModel = withRequestBudget(host.roleModel(role), () => request.ledger);
      const memory = new HistoryReferenceMemory(options.autoCompactionMode === "history-reference");
      memories.set(execution.task.sessionId, memory);
      const summary = new SummaryTailStrategy({ summarizer: createModelContextSummarizer(childModel) });
      request.registerGuard(execution.task.id, files);
      const childTools = [...files.tools, ...tools, ...memory.tools()];
      const childInstructions = definePlugin({
        id: "may.delegation.child-instructions",
        version: "1.0.0",
        requires: [
          { service: applicationServices.instructionSources },
          { service: applicationServices.toolSources },
          { service: applicationServices.contextWrappers },
        ],
        optional: [{ service: applicationServices.tools }],
        requiresHooks: [runtimeHooks.runBefore, applicationHooks.inputReceived],
        async setup(context) {
          const sources = context.get(applicationServices.instructionSources);
          const registration = { pluginOrder: context.pluginOrder };
          const sessionOrigin =
            (await options.store.read(execution.task.sessionId)).length > 0 ? "resumed session" : "new session";
          context.defer(
            context.get(applicationServices.contextWrappers).add(
              (factory) => ({
                create: async (current) => {
                  const { measurement: _measurement, ...options } = current;
                  return factory.create(options);
                },
              }),
              { ...registration, id: context.pluginId, order: -100 },
            ),
          );
          context.defer(
            sources.add(
              () => {
                const shell = [
                  ...childTools,
                  ...context.get(applicationServices.toolSources).snapshot(),
                  ...(context.optional(applicationServices.tools) ?? []),
                ]
                  .map(getShellToolInfo)
                  .find((info) => info !== undefined);
                return (
                  "# Current environment\n\n" +
                  codingRuntimeInstructions(
                    omitUndefined({
                      workspace: options.workspace,
                      execution: options.execution?.isolation,
                      shell,
                      agentRole: "sub-agent",
                      assignedRole: role.name,
                      parentTask: execution.task.parentTaskId ?? execution.task.id,
                      sessionOrigin,
                      permissionMode: options.permissionModeSource?.(),
                    }),
                  )
                );
              },
              { ...registration, id: `${context.pluginId}.environment`, order: -80 },
            ),
          );
          if (options.projectInstructionsSource !== undefined) {
            context.defer(
              sources.add(options.projectInstructionsSource, {
                ...registration,
                id: `${context.pluginId}.project`,
                order: -60,
              }),
            );
          }
          context.defer(
            sources.add(
              () => "# Tool use\n\nUse the available tools according to their descriptions and parameter schemas.",
              {
                ...registration,
                id: `${context.pluginId}.tools`,
                order: -40,
              },
            ),
          );
          context.defer(
            sources.add(
              () =>
                subagentInstructions({
                  base: "",
                  role,
                  workspace: options.workspace,
                  files: execution.task.files ?? [],
                  maxDepthReached: host.depthOf(execution.task) >= options.configuration.limits.maxDepth,
                }),
              { ...registration, id: `${context.pluginId}.assignment`, order: 20 },
            ),
          );
          context.defer(
            sources.add(() => memory.instructions(), {
              ...registration,
              id: `${context.pluginId}.continuity`,
              order: 60,
            }),
          );
          if (options.prepareInstructions !== undefined) {
            context.on(runtimeHooks.runBefore, () => options.prepareInstructions!(), { order: -100 });
            context.on(applicationHooks.inputReceived, () => options.prepareInstructions!(), { order: -100 });
          }
        },
      });
      return defineAgent({
        requestRecording: options.requestRecording,
        providerBodyRecording: options.providerBodyRecording,
        model: childModel,
        plugins: [childInstructions],
        tools: childTools,
        toolScope: { workspaceId: options.workspace },
        ...omitUndefined({
          beforeToolExecute: options.beforeToolExecute,
          skills: options.skills,
          contextBudget,
          compactionStrategy: options.compactionStrategy,
          tracer: options.tracer,
        }),
        toolSource: () => [...(options.toolSource?.() ?? [])],
        instructions: options.instructionsSource?.() ?? options.instructions,
        permissionPolicy: options.permissionPolicy,
        sessionHistory: { retrieval: true },
        contextFactory: memory.wrap(new InMemoryContextFactory(), { includeInstructions: false }),
        autoCompactionStrategies: automaticCompactionStrategies(
          options.autoCompactionMode,
          summary,
          memory.strategy,
          childModel.contextCompactor === undefined
            ? undefined
            : new ModelContextCompactionStrategy(childModel.contextCompactor),
        ),
        // maxSteps 已确定，角色预算与子 Agent 预算的较小值对子 Run 同样生效。
        maxSteps,
        runBudget: roleBudget,
        traceAttributes: {
          ...(options.traceAttributes ?? {}),
          "may.agent.name": "maybecode-subagent",
          "may.task.role": role.name,
        },
        closeReason: "Sub-agent Session is closing",
      });
    },
  });
  return {
    version: VERSION,
    async execute(execution, context) {
      try {
        const output = await scoped.execute(execution, context);
        if ("yielded" in output) return output;
        const note = host.activeRequest()?.guard(execution.task.id)?.note() ?? "";
        return note === "" ? output : { ...output, text: `${output.text}${note}` };
      } finally {
        memories.delete(execution.task.sessionId);
      }
    },
    recover: (execution) => scoped.recover(execution),
    resolveApproval: async (sessionId, requestId, decision) =>
      (await scoped.resolveApproval?.(sessionId, requestId, decision)) ?? false,
  };
}
