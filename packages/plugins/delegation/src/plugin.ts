import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { applicationHooks, applicationServices, contextBudgetFromModel, withDefaultCompactionThreshold } from "@may/application";
import { definePlugin, defineService } from "@may/plugin";
import { goalsService } from "@may/plugin-goals";
import { mcpService } from "@may/plugin-mcp";
import type { AutoCompactionMode } from "@may/plugin-history-memory";
import type { ContextBudget, ContextCompactionStrategy } from "@may/context";
import type { Model, Tool, TraceAttributes } from "@may/core";
import type { SkillRegistry } from "@may/skills";
import { SubagentHost } from "./subagent-host.js";
import { SharedWorkspaceFileGuard } from "./subagent-files.js";
import { withRequestBudget } from "./subagent-budget.js";
import { defaultSubagentConfiguration, SUBAGENT_TOOL_NAMES, type MaybeCodeSubagentConfiguration, type MaybeCodeSubagentRole } from "./subagents.js";
import type { MaybeCodeDelegationRequest } from "./delegation.js";

export interface DelegationAccess { get(): SubagentHost }
export const delegationService = defineService<DelegationAccess>({ id: "may.delegation", version: "1.0.0", scope: "application" });
export const workspaceFilesService = defineService<SharedWorkspaceFileGuard>({ id: "may.workspace-files", version: "1.0.0", scope: "application" });

export function createWorkspaceFilesPlugin(options: { readonly workspace: string; readonly defaultTools?: boolean }) {
  return definePlugin({
    id: "may.workspace-files", version: "1.0.0", scope: "application",
    provides: [workspaceFilesService], requires: [{ service: applicationServices.toolSources }],
    setup(context) {
      const guard = new SharedWorkspaceFileGuard(resolve(options.workspace));
      context.provide(workspaceFilesService, guard);
      if (options.defaultTools !== false) {
        const tools = guard.create({ names: [...SUBAGENT_TOOL_NAMES], requireRead: false }).tools;
        context.defer(context.get(applicationServices.toolSources).add(() => tools, { id: context.pluginId, pluginOrder: context.pluginOrder }));
      }
    },
  });
}

export interface DelegationPluginOptions {
  readonly workspace: string;
  readonly configuration?: MaybeCodeSubagentConfiguration;
  readonly dataDirectory?: string;
  readonly createRoleModel?: (role: MaybeCodeSubagentRole) => Model | undefined;
  readonly contextBudgetFor?: (role: MaybeCodeSubagentRole) => ContextBudget | undefined;
  readonly instructions: string;
  readonly skills?: SkillRegistry;
  readonly toolSource?: () => Iterable<Tool>;
  readonly contextBudget?: ContextBudget;
  readonly compactionStrategy?: ContextCompactionStrategy;
  readonly autoCompactionMode?: AutoCompactionMode;
  readonly maxSteps?: number;
  readonly traceAttributes?: TraceAttributes;
}

interface RequestState { readonly requests: readonly MaybeCodeDelegationRequest[] }

export function createDelegationPlugin(options: DelegationPluginOptions) {
  return definePlugin({
    id: "may.delegation", version: "1.0.0", scope: "application", provides: [delegationService],
    requires: [
      { service: applicationServices.application }, { service: applicationServices.model },
      { service: applicationServices.sessionStore }, { service: applicationServices.permissionPolicy },
      { service: applicationServices.toolSources }, { service: applicationServices.instructionSources },
      { service: applicationServices.modelWrappers }, { service: workspaceFilesService },
    ],
    optional: [{ service: goalsService }, { service: applicationServices.tracer }, { service: mcpService }],
    requiresHooks: [applicationHooks.created, applicationHooks.beforeClose],
    state: { version: 1, initial: { requests: [] } },
    setup(context) {
      let host: SubagentHost | undefined;
      context.defer(context.get(applicationServices.modelWrappers).add(
        model => withRequestBudget(model, () => host?.ledger()), { id: context.pluginId, order: 20, pluginOrder: context.pluginOrder },
      ));
      context.defer(context.get(applicationServices.toolSources).add(() => host?.tools() ?? [], { id: context.pluginId, pluginOrder: context.pluginOrder }));
      context.defer(context.get(applicationServices.instructionSources).add(() => host?.instructions() ?? "", { id: context.pluginId, pluginOrder: context.pluginOrder }));
      context.provide(delegationService, {
        get() {
          if (host === undefined) throw new Error("Delegation is unavailable before application creation");
          return host;
        },
      });
      context.defer(async () => { await host?.close(); });
      context.on(applicationHooks.created, async () => {
        const application = context.get(applicationServices.application).get();
        const store = context.get(applicationServices.sessionStore);
        const rawModel = context.get(applicationServices.model);
        const goals = context.optional(goalsService);
        const wrapChildModel = (model: Model) => goals?.wrapModel(model, { includeInstructions: false }) ?? model;
        const model = wrapChildModel(rawModel);
        const mcp = context.optional(mcpService);
        const contextBudget = withDefaultCompactionThreshold(options.contextBudget ?? contextBudgetFromModel(model));
        host = new SubagentHost({
          configuration: options.configuration ?? defaultSubagentConfiguration(),
          workspace: resolve(options.workspace),
          dataDirectory: options.dataDirectory ?? (store.directory === undefined ? join(homedir(), ".may", "maybecode") : dirname(store.directory)),
          sessionId: application.sessionId, application, store, model,
          instructions: options.instructions,
          permissionPolicy: context.get(applicationServices.permissionPolicy),
          fileGuard: context.get(workspaceFilesService),
          autoCompactionMode: options.autoCompactionMode ?? "prune-summary",
          ...(options.createRoleModel === undefined ? {} : { createRoleModel: (role: MaybeCodeSubagentRole) => {
            const selected = options.createRoleModel!(role);
            return selected === undefined ? undefined : wrapChildModel(selected);
          } }),
          ...(options.contextBudgetFor === undefined ? {} : { contextBudgetFor: options.contextBudgetFor }),
          ...(options.skills === undefined && application.skills === undefined ? {} : { skills: options.skills ?? application.skills!.registry }),
          ...(options.toolSource === undefined && mcp === undefined ? {} : {
            toolSource: () => [...(options.toolSource?.() ?? []), ...(mcp?.tools ?? [])],
          }),
          ...(contextBudget === undefined ? {} : { contextBudget }),
          ...(options.compactionStrategy === undefined ? {} : { compactionStrategy: options.compactionStrategy }),
          ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
          ...(context.optional(applicationServices.tracer) === undefined ? {} : { tracer: context.optional(applicationServices.tracer)! }),
          ...(options.traceAttributes === undefined ? {} : { traceAttributes: options.traceAttributes }),
          loadRequests: async () => {
            const saved = context.state.get<RequestState>().requests;
            if (saved.length > 0) return saved;
            const event = [...await application.history()].reverse().find(item => item.type === "state.updated" && item.key === "may.subagents");
            if (event?.type !== "state.updated") return [];
            const value = event.value as { version?: unknown; requests?: unknown };
            if (value.version !== 1 || !Array.isArray(value.requests)) throw new TypeError("Unsupported delegation request state");
            return value.requests as MaybeCodeDelegationRequest[];
          },
          saveRequests: async requests => {
            const saved = requests.slice(0, 16);
            await context.state.set({ requests: saved });
            await application.recordState("may.subagents", { version: 1, requests: saved });
          },
        });
        await host.initialize();
      }, { order: 10 });
      context.on(applicationHooks.beforeClose, async () => { await host?.close(); }, { order: 20 });
    },
  });
}
