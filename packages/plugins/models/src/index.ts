import type { Model } from "@may/core";
import { definePlugin, type Disposer, type PluginContext, type PluginDefinition } from "@may/plugin";
import { services, factoryMetadata, type ModelInfo, type ModelWrapper, type ContributionOptions, type PluginFactoryMetadata } from "@may/plugin-services";

export interface ModelPluginOptions<C = unknown> extends PluginFactoryMetadata<C> {
  readonly id?: string;
  readonly create: (context: PluginContext<C>) => Model | Promise<Model>;
  readonly info?: ModelInfo;
  readonly dispose?: (model: Model) => void | Promise<void>;
}
export function createModelPlugin<C = unknown>(options: ModelPluginOptions<C>): PluginDefinition<C> {
  const info = options.info === undefined ? undefined : snapshotModelInfo(options.info);
  return definePlugin({ ...factoryMetadata(options), id: options.id ?? "may.model", provides: [services.model, ...(info === undefined ? [] : [services.modelInfo])], async setup(context) {
    const model = await options.create(context);
    if (options.dispose) context.defer(() => options.dispose!(model));
    if (typeof model?.stream !== "function") throw new TypeError("Model plugin must create a Model");
    context.provide(services.model, model);
    if (info !== undefined) context.provide(services.modelInfo, info);
  } });
}

function snapshotModelInfo(info: ModelInfo): ModelInfo {
  for (const key of ["provider", "model", "adapter", "profile"] as const) {
    const value = info[key];
    if ((value === undefined && (key === "provider" || key === "model")) ||
        (value !== undefined && (typeof value !== "string" || value.trim() === ""))) {
      throw new TypeError(`Model info ${key} must be a non-empty string`);
    }
  }
  return Object.freeze({ ...info });
}

export interface ModelWrapperPluginOptions<C = unknown> extends Omit<ContributionOptions, "pluginOrder">, PluginFactoryMetadata<C> {
  readonly create: (context: PluginContext<C>) => ModelWrapper | Promise<ModelWrapper>;
  readonly dispose?: Disposer;
}
export function createModelWrapperPlugin<C = unknown>(options: ModelWrapperPluginOptions<C>): PluginDefinition<C> {
  return definePlugin({ ...factoryMetadata(options, [{ service: services.modelWrappers }]), id: options.id, async setup(context) {
    if (options.dispose) context.defer(options.dispose);
    context.defer(context.get(services.modelWrappers).add(await options.create(context), {
      id: context.pluginId, pluginOrder: context.pluginOrder, ...(options.order === undefined ? {} : { order: options.order }),
    }));
  } });
}
