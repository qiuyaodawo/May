import type { Model, RuntimeFactory, Tool, ToolExecutor, ToolScheduler, Tracer } from "@sortedyuan/core";
import type { ContextBudget, ContextCompactionStrategy, ContextFactory } from "@sortedyuan/context";
import type { PermissionPolicy } from "@sortedyuan/permissions";
import { defineService } from "@sortedyuan/plugin";
import type { SessionStore } from "@sortedyuan/session";
import type { SkillSession } from "@sortedyuan/skills";
import { ContextWrappers, InstructionSources, ModelWrappers, ToolSources } from "./registries.js";

export interface ContextOptions {
  readonly budget?: ContextBudget;
  readonly compactionStrategy?: ContextCompactionStrategy;
  readonly autoCompactionStrategies?: readonly ContextCompactionStrategy[];
  readonly providerNativeAutoCompaction?: boolean;
}
export type ContextOptionsSource = ContextOptions | ((model: Model) => ContextOptions);

export interface ModelInfo {
  readonly provider: string;
  readonly model: string;
  readonly adapter?: string;
  readonly profile?: string;
}

const token = <T>(id: string) => defineService<T>({ id, version: "1.0.0", scope: "application" });
export const services = Object.freeze({
  model: token<Model>("may.model"),
  modelInfo: token<ModelInfo>("may.model-info"),
  contextFactory: token<ContextFactory>("may.context-factory"),
  contextOptions: token<ContextOptionsSource>("may.context-options"),
  sessionStore: token<SessionStore>("may.session-store"),
  permissionPolicy: token<PermissionPolicy>("may.permission-policy"),
  toolExecutor: token<ToolExecutor>("may.tool-executor"),
  toolScheduler: token<ToolScheduler>("may.tool-scheduler"),
  tracer: token<Tracer>("may.tracer"),
  tools: token<Iterable<Tool>>("may.tools"),
  skills: token<SkillSession>("may.skills"),
  toolSources: token<ToolSources>("may.tool-sources"),
  instructionSources: token<InstructionSources>("may.instruction-sources"),
  modelWrappers: token<ModelWrappers>("may.model-wrappers"),
  contextWrappers: token<ContextWrappers>("may.context-wrappers"),
  runtimeFactory: token<RuntimeFactory>("may.runtime-factory"),
});
