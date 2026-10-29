import type { Model, RuntimeFactory, Tool, ToolExecutor, ToolScheduler, Tracer } from "../core/index.js";
import type { ContextBudget, ContextCompactionStrategy, ContextFactory } from "../context/index.js";
import type { PermissionPolicy } from "../permissions/index.js";
import { defineService } from "../plugin/index.js";
import type { SessionStore } from "../session/index.js";
import type { SkillSession } from "../skills/index.js";
import type { ContextWrapperRegistry, InstructionSourceRegistry, ModelWrapperRegistry, ToolSourceRegistry } from "./registries.js";

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
  toolSources: token<ToolSourceRegistry>("may.tool-sources"),
  instructionSources: token<InstructionSourceRegistry>("may.instruction-sources"),
  modelWrappers: token<ModelWrapperRegistry>("may.model-wrappers"),
  contextWrappers: token<ContextWrapperRegistry>("may.context-wrappers"),
  runtimeFactory: token<RuntimeFactory>("may.runtime-factory"),
});
