import type { PluginDefinition } from "@sortedyuan/plugin";
import {
  services, ToolSources, InstructionSources, ModelWrappers, ContextWrappers,
  type ToolSourceRegistry, type InstructionSourceRegistry, type ModelWrapperRegistry, type ContextWrapperRegistry,
} from "@sortedyuan/plugin-services";

export function createRegistryPlugin(version: string): PluginDefinition {
  return {
    id: "verification.structural-registries", version,
    provides: [services.toolSources, services.instructionSources, services.modelWrappers, services.contextWrappers],
    setup(context) {
      const tools = new ToolSources();
      const instructions = new InstructionSources();
      const models = new ModelWrappers();
      const contexts = new ContextWrappers();
      const toolRegistry: ToolSourceRegistry = { add: (value, options) => tools.add(value, options), snapshot: () => [...tools.snapshot()] };
      const instructionRegistry: InstructionSourceRegistry = { add: (value, options) => instructions.add(value, options), snapshot: () => instructions.snapshot() };
      const modelRegistry: ModelWrapperRegistry = { add: (value, options) => models.add(value, options), apply: model => models.apply(model) };
      const contextRegistry: ContextWrapperRegistry = { add: (value, options) => contexts.add(value, options), apply: factory => contexts.apply(factory) };
      context.provide(services.toolSources, toolRegistry);
      context.provide(services.instructionSources, instructionRegistry);
      context.provide(services.modelWrappers, modelRegistry);
      context.provide(services.contextWrappers, contextRegistry);
    },
  };
}
