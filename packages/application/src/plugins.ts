import { defineService, type PluginContext, type PluginDefinition, type PluginStateSnapshot } from "@may/plugin";
import { services, ToolSources, InstructionSources, ModelWrappers, ContextWrappers } from "@may/plugin-services";
import { createRuntimePlugin } from "@may/plugin-runtime";
import type { AgentApplication } from "./application.js";

export type { RuntimeFactory } from "@may/core";

export interface ApplicationAccess { get(): AgentApplication; }

export const applicationServices = Object.freeze({
  ...services,
  application: defineService<ApplicationAccess>({ id: "may.application-access", version: "1.0.0", scope: "application" }),
});

export const defaultRuntimePlugin: PluginDefinition = createRuntimePlugin();

export function createCompositionPlugin(existing: readonly PluginDefinition[]): PluginDefinition {
  const factory = <T>(service: import("@may/plugin").ServiceToken<T>, create: () => T) => ({
    service, provide(context: PluginContext) { context.provide(service, create()); },
  });
  const factories = [
    factory(services.toolSources, () => new ToolSources()),
    factory(services.instructionSources, () => new InstructionSources()),
    factory(services.modelWrappers, () => new ModelWrappers()),
    factory(services.contextWrappers, () => new ContextWrappers()),
  ];
  const defaults = factories.filter(({ service }) => !existing.some((plugin) => plugin.provides?.some((provided) => provided.id === service.id && provided.scope === service.scope)));
  return {
    id: "may.composition", version: "1.0.0", provides: defaults.map(({ service }) => service),
    setup(context: PluginContext) {
      for (const entry of defaults) entry.provide(context);
    },
  };
}

export const applicationInfrastructurePlugin: PluginDefinition = Object.freeze({
  id: "may.application",
  version: "1.0.0",
  scope: "application",
  requires: [
    { service: applicationServices.model },
    { service: applicationServices.contextFactory },
    { service: applicationServices.permissionPolicy },
    { service: applicationServices.sessionStore },
    { service: applicationServices.runtimeFactory },
    { service: applicationServices.toolSources },
    { service: applicationServices.instructionSources },
    { service: applicationServices.modelWrappers },
    { service: applicationServices.contextWrappers },
    { service: applicationServices.application },
  ],
  optional: [{ service: applicationServices.modelInfo }],
  setup() {},
});

export interface PluginUpdateOptions {
  readonly cancelActive?: boolean;
}

export interface ApplicationPluginState {
  readonly version: 1;
  readonly application: PluginStateSnapshot;
  readonly session: PluginStateSnapshot;
}

export const PLUGIN_STATE_KEY = "may.plugins";

export function readApplicationPluginState(value: unknown): ApplicationPluginState {
  if (value === undefined) return { version: 1, application: {}, session: {} };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Invalid application plugin state");
  }
  const candidate = value as Partial<ApplicationPluginState>;
  if (candidate.version !== 1 || typeof candidate.application !== "object" || candidate.application === null ||
      Array.isArray(candidate.application) || typeof candidate.session !== "object" || candidate.session === null ||
      Array.isArray(candidate.session)) {
    throw new TypeError("Unsupported application plugin state format");
  }
  return structuredClone(candidate) as ApplicationPluginState;
}
