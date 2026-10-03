import { May, type RuntimeFactory } from "@may/core";
import { InMemoryContextFactory, type ContextFactory } from "@may/context";
import { definePlugin, type PluginContext, type PluginDefinition, type Disposer } from "@may/plugin";
import { services, factoryMetadata, type PluginFactoryMetadata, type ContextOptionsSource, type ContextWrapper, type ContributionOptions, type ToolSource } from "@may/plugin-services";

export interface RuntimePluginOptions<C = unknown> extends PluginFactoryMetadata<C> {
  readonly id?: string;
  readonly factory?: RuntimeFactory;
  readonly create?: (context: PluginContext<C>) => RuntimeFactory | Promise<RuntimeFactory>;
  readonly dispose?: (factory: RuntimeFactory) => void | Promise<void>;
}
export function createRuntimePlugin<C = unknown>(factoryOrOptions: RuntimeFactory | RuntimePluginOptions<C> = {}, id = "may.runtime"): PluginDefinition<C> {
  const options: RuntimePluginOptions<C> = typeof factoryOrOptions === "function" ? { id, factory: factoryOrOptions } : factoryOrOptions;
  if (options.create !== undefined && options.factory !== undefined) throw new TypeError("Runtime plugin accepts one factory source");
  return definePlugin({ ...factoryMetadata(options), id: options.id ?? id, provides: [services.runtimeFactory], async setup(context) {
    const factory = options.create === undefined ? options.factory ?? ((input) => new May(input)) : await options.create(context);
    if (options.dispose) context.defer(() => options.dispose!(factory));
    if (typeof factory !== "function") throw new TypeError("Runtime plugin must create a RuntimeFactory");
    context.provide(services.runtimeFactory, factory);
  } });
}

export interface ContextPluginOptions<C = unknown> extends PluginFactoryMetadata<C> {
  readonly id?: string;
  readonly create?: (context: PluginContext<C>) => ContextFactory | Promise<ContextFactory>;
  readonly options?: ContextOptionsSource;
  readonly dispose?: (factory: ContextFactory) => void | Promise<void>;
}
export function createContextPlugin<C = unknown>(options: ContextPluginOptions<C> = {}): PluginDefinition<C> {
  return definePlugin({ ...factoryMetadata(options), id: options.id ?? "may.context", provides: [services.contextFactory, ...(options.options === undefined ? [] : [services.contextOptions])], async setup(context) {
    const factory = options.create === undefined ? new InMemoryContextFactory() : await options.create(context);
    if (options.dispose) context.defer(() => options.dispose!(factory));
    if (typeof factory?.create !== "function") throw new TypeError("Context plugin must create a ContextFactory");
    context.provide(services.contextFactory, factory);
    if (options.options !== undefined) context.provide(services.contextOptions, options.options);
  } });
}

export interface ContextWrapperPluginOptions<C = unknown> extends Omit<ContributionOptions, "pluginOrder">, PluginFactoryMetadata<C> {
  readonly create: (context: PluginContext<C>) => ContextWrapper | Promise<ContextWrapper>;
  readonly dispose?: Disposer;
}
export function createContextWrapperPlugin<C = unknown>(options: ContextWrapperPluginOptions<C>): PluginDefinition<C> {
  return definePlugin({ ...factoryMetadata(options, [{ service: services.contextWrappers }]), id: options.id, async setup(context) {
    if (options.dispose) context.defer(options.dispose);
    context.defer(context.get(services.contextWrappers).add(await options.create(context), {
      id: context.pluginId, pluginOrder: context.pluginOrder, ...(options.order === undefined ? {} : { order: options.order }),
    }));
  } });
}

export interface ToolsPluginOptions<C = unknown> extends Omit<ContributionOptions, "pluginOrder">, PluginFactoryMetadata<C> {
  readonly create: (context: PluginContext<C>) => ToolSource | Promise<ToolSource>;
  readonly dispose?: Disposer;
}
export function createToolsPlugin<C = unknown>(options: ToolsPluginOptions<C>): PluginDefinition<C> {
  return definePlugin({ ...factoryMetadata(options, [{ service: services.toolSources }]), id: options.id, async setup(context) {
    if (options.dispose) context.defer(options.dispose);
    context.defer(context.get(services.toolSources).add(await options.create(context), {
      id: context.pluginId, pluginOrder: context.pluginOrder, ...(options.order === undefined ? {} : { order: options.order }),
    }));
  } });
}
