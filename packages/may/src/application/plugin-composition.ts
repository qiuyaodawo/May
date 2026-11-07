import { omitUndefined, ToolRegistry } from "../core/index.js";
import type { AnyPlugin, ServiceToken } from "../plugin/index.js";
import { createModelPlugin } from "../services/models.js";
import { createContextPlugin, createToolsPlugin } from "../services/runtime.js";
import { createPermissionPlugin } from "../services/permissions.js";
import { createSkillsPlugin } from "../services/skills.js";
import type { AgentApplicationOptions } from "./application.js";
import type { createApplicationAccess } from "./plugin-access.js";
import {
  applicationServices,
  defaultRuntimePlugin,
  applicationInfrastructurePlugin,
  createCompositionPlugin,
} from "./plugins.js";

export function composeApplicationPlugins(
  plugins: readonly AnyPlugin[],
  options: AgentApplicationOptions,
  access: ReturnType<typeof createApplicationAccess>,
  instructions: () => string,
): readonly AnyPlugin[] {
  const composition: AnyPlugin[] = [...plugins];
  const provided = (service: ServiceToken) =>
    composition.some((plugin) =>
      plugin.provides?.some((token) => token.id === service.id && token.scope === service.scope),
    );
  const valuePlugin = <T>(service: ServiceToken<T>, value: T): AnyPlugin => ({
    id: `may.supplied.${service.id}`,
    version: "1.0.0",
    provides: [service],
    setup(context) {
      context.provide(service, value);
    },
  });
  composition.push(valuePlugin(applicationServices.sessionStore, options.store));
  composition.push(valuePlugin(applicationServices.application, access.application));
  composition.push(valuePlugin(applicationServices.execution, access.execution));
  composition.push(valuePlugin(applicationServices.history, access.history));
  composition.push(valuePlugin(applicationServices.state, access.state));
  if (options.model !== undefined) composition.push(createModelPlugin({ create: () => options.model! }));
  if (options.permissionPolicy !== undefined)
    composition.push(createPermissionPlugin({ create: () => options.permissionPolicy! }));
  else if (!provided(applicationServices.permissionPolicy))
    composition.push(
      createPermissionPlugin({
        create: () => () => {
          throw new TypeError("permissionPolicy is required for tool execution");
        },
      }),
    );
  if (options.contextFactory !== undefined || !provided(applicationServices.contextFactory)) {
    composition.push(
      createContextPlugin({
        ...(options.contextFactory === undefined ? {} : { create: () => options.contextFactory! }),
      }),
    );
  }
  if (
    [
      options.contextBudget,
      options.compactionStrategy,
      options.autoCompactionStrategies,
      options.providerNativeAutoCompaction,
    ].some((value) => value !== undefined)
  ) {
    composition.push(
      valuePlugin(
        applicationServices.contextOptions,
        omitUndefined({
          budget: options.contextBudget,
          compactionStrategy: options.compactionStrategy,
          autoCompactionStrategies: options.autoCompactionStrategies,
          providerNativeAutoCompaction: options.providerNativeAutoCompaction,
        }),
      ),
    );
  }
  if (options.toolExecutor !== undefined)
    composition.push(valuePlugin(applicationServices.toolExecutor, options.toolExecutor));
  if (options.toolScheduler !== undefined)
    composition.push(valuePlugin(applicationServices.toolScheduler, options.toolScheduler));
  if (options.tracer !== undefined) composition.push(valuePlugin(applicationServices.tracer, options.tracer));
  if (options.skills !== undefined) composition.push(createSkillsPlugin({ create: () => options.skills! }));
  if (options.tools !== undefined || options.toolSource !== undefined) {
    const tools = new ToolRegistry(options.tools);
    composition.push(
      createToolsPlugin({
        id: "may.supplied.tools",
        order: -100,
        create: () => () => [...tools, ...(options.toolSource?.() ?? [])],
      }),
    );
  }
  composition.push({
    id: "may.supplied.instructions",
    version: "1.0.0",
    requires: [{ service: applicationServices.instructionSources }],
    setup(context) {
      context.defer(
        context.get(applicationServices.instructionSources).add(instructions, {
          id: context.pluginId,
          order: -100,
          pluginOrder: context.pluginOrder,
        }),
      );
    },
  });
  if (!provided(applicationServices.runtimeFactory)) composition.push(defaultRuntimePlugin);
  composition.push(createCompositionPlugin(composition), applicationInfrastructurePlugin);
  return composition;
}
