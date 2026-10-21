import type { PermissionPolicy } from "@sortedyuan/permissions";
import { definePlugin, type PluginContext, type PluginDefinition } from "@sortedyuan/plugin";
import { services, factoryMetadata, type PluginFactoryMetadata } from "./index.js";

export interface PermissionPluginOptions<C = unknown> extends PluginFactoryMetadata<C> {
  readonly id?: string;
  readonly create: (context: PluginContext<C>) => PermissionPolicy | Promise<PermissionPolicy>;
  readonly dispose?: (policy: PermissionPolicy) => void | Promise<void>;
}
export function createPermissionPlugin<C = unknown>(options: PermissionPluginOptions<C>): PluginDefinition<C> {
  return definePlugin({ ...factoryMetadata(options), id: options.id ?? "may.permissions", provides: [services.permissionPolicy], async setup(context) {
    const policy = await options.create(context);
    if (options.dispose) context.defer(() => options.dispose!(policy));
    if (typeof policy !== "function") throw new TypeError("Permission plugin must create a policy");
    context.provide(services.permissionPolicy, policy);
  } });
}
