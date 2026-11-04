import { omitUndefined } from "../core/omit-undefined.js";
import type { PluginDefinition, ServiceDependency } from "../plugin/index.js";

export type PluginFactoryMetadata<C = unknown> = Pick<PluginDefinition<C>,
  "config" | "configSchema" | "requires" | "optional" | "requiresHooks" | "state"
> & { readonly version?: string };

export function factoryMetadata<C>(options: PluginFactoryMetadata<C>, defaults: readonly ServiceDependency[] = []): Omit<PluginDefinition<C>, "id" | "provides" | "setup"> {
  const requires = [...defaults.filter((dependency) => !options.requires?.some((declared) =>
    declared.service.id === dependency.service.id && declared.service.scope === dependency.service.scope)), ...(options.requires ?? [])];
  return {
    scope: "application", version: options.version ?? "1.0.0",
    ...omitUndefined({
      config: options.config,
      configSchema: options.configSchema,
      requires: requires.length === 0 ? undefined : requires,
      optional: options.optional,
      requiresHooks: options.requiresHooks,
      state: options.state,
    }),
  };
}
