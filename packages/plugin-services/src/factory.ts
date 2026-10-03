import type { PluginDefinition, ServiceDependency } from "@may/plugin";

export type PluginFactoryMetadata<C = unknown> = Pick<PluginDefinition<C>,
  "config" | "configSchema" | "requires" | "optional" | "requiresHooks" | "state"
> & { readonly version?: string };

export function factoryMetadata<C>(options: PluginFactoryMetadata<C>, defaults: readonly ServiceDependency[] = []): Omit<PluginDefinition<C>, "id" | "provides" | "setup"> {
  const requires = [...defaults.filter((dependency) => !options.requires?.some((declared) =>
    declared.service.id === dependency.service.id && declared.service.scope === dependency.service.scope)), ...(options.requires ?? [])];
  return {
    scope: "application", version: options.version ?? "1.0.0",
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.configSchema === undefined ? {} : { configSchema: options.configSchema }),
    ...(requires.length === 0 ? {} : { requires }),
    ...(options.optional === undefined ? {} : { optional: options.optional }),
    ...(options.requiresHooks === undefined ? {} : { requiresHooks: options.requiresHooks }),
    ...(options.state === undefined ? {} : { state: options.state }),
  };
}
