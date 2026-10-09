import { applicationHooks, applicationServices } from "@may/application";
import { runtimeHooks, ToolRegistry } from "@may/core";
import { definePlugin } from "@may/plugin";
import { MaybeCodeInstructionState } from "../instructions.js";
import { maybeCodeRuntimeInstructions, type MaybeCodeRuntimeEnvironment } from "../runtime-instructions.js";

export function createMaybeCodeInstructionsPlugin(
  state: MaybeCodeInstructionState,
  environment: MaybeCodeRuntimeEnvironment,
) {
  return definePlugin({
    id: "maybecode.instructions", version: "1.0.0", scope: "application",
    requires: [{ service: applicationServices.instructionSources }, { service: applicationServices.toolSources },
      { service: applicationServices.contextWrappers }],
    optional: [{ service: applicationServices.tools }],
    requiresHooks: [runtimeHooks.runBefore, applicationHooks.inputReceived],
    setup(context) {
      const sources = context.get(applicationServices.instructionSources);
      const catalog = context.get(applicationServices.toolSources);
      const registration = { pluginOrder: context.pluginOrder };
      context.defer(context.get(applicationServices.contextWrappers).add(factory => ({
        create: async options => {
          const { measurement: _measurement, ...current } = options;
          return factory.create(current);
        },
      }), { ...registration, id: context.pluginId, order: -100 }));
      state.runtimeInstructions = () => maybeCodeRuntimeInstructions(environment,
        ToolRegistry.compose(catalog.snapshot(), context.optional(applicationServices.tools) ?? []));
      context.defer(() => { state.runtimeInstructions = undefined; });
      context.defer(sources.add(() => "# Current environment\n\n" + state.runtimeInstructions!(), {
        ...registration, id: `${context.pluginId}.environment`, order: -80,
      }));
      context.defer(sources.add(() => state.projectInstructions(), {
        ...registration, id: `${context.pluginId}.project`, order: -60,
      }));
      context.defer(sources.add(() => "# Tool use\n\nUse the available tools according to their descriptions and parameter schemas.", {
        ...registration, id: `${context.pluginId}.tools`, order: -40,
      }));
      context.on(runtimeHooks.runBefore, () => state.refreshProject(), { order: -100 });
      context.on(applicationHooks.inputReceived, () => state.refreshProject(), { order: -100 });
    },
  });
}
