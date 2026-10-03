import { Ajv, type ValidateFunction } from "ajv";
import { satisfies, valid, validRange } from "semver";
import { isDeepStrictEqual } from "node:util";
import type { HookDefinition, JsonSchema } from "@may/core";
import type { AnyPlugin, PluginDefinition, PluginScope, ServiceBinding, ServiceToken } from "./types.js";
import { immutable } from "./hooks.js";

const ajv = new Ajv({ allErrors: true, strict: true, addUsedSchema: false });
const validators = new WeakMap<object, ValidateFunction>();
const pluginSources = new WeakMap<AnyPlugin, AnyPlugin>();
export const scopes: readonly PluginScope[] = ["host", "application", "session", "run"];

export function validateSchema(schema: JsonSchema | undefined, value: unknown, label: string): void {
  if (!schema) return;
  let validator = validators.get(schema);
  if (!validator) {
    validator = ajv.compile(schema);
    if ((validator as ValidateFunction & { $async?: boolean }).$async) {
      throw new Error(`${label}: asynchronous JSON Schema validation is unsupported`);
    }
    validators.set(schema, validator);
  }
  if (!validator(value)) throw new Error(`${label}: ${ajv.errorsText(validator.errors)}`);
}

export function scopeIndex(scope: PluginScope): number {
  const index = scopes.indexOf(scope);
  if (index < 0) throw new Error(`Unknown plugin scope: ${scope}`);
  return index;
}

export function pluginScope(plugin: AnyPlugin): PluginScope {
  return plugin.scope ?? "application";
}

export function validateToken(token: ServiceToken): void {
  if (!token.id.trim()) throw new Error("Service id must not be empty");
  if (!valid(token.version)) throw new Error(`Invalid version for service ${token.id}: ${token.version}`);
  scopeIndex(token.scope);
  if (new Set(token.capabilities).size !== token.capabilities.length) {
    throw new Error(`Duplicate capabilities for service ${token.id}`);
  }
}

export function defineService<T>(definition: Omit<ServiceToken<T>, "capabilities" | "valueType"> & {
  readonly capabilities?: readonly string[];
}): ServiceToken<T> {
  const token = { ...definition, capabilities: Object.freeze([...(definition.capabilities ?? [])]) };
  validateToken(token);
  return Object.freeze(token);
}

export function definePlugin<C = unknown>(definition: PluginDefinition<C>): PluginDefinition<C> {
  return Object.freeze(definition);
}

export function pluginSource(plugin: AnyPlugin): AnyPlugin {
  return pluginSources.get(plugin) ?? plugin;
}

export function snapshotPlugin(plugin: AnyPlugin): AnyPlugin {
  if (pluginSources.has(plugin)) return plugin;
  const snapshot: AnyPlugin = Object.freeze({
    ...plugin,
    ...(plugin.config === undefined ? {} : { config: immutable(plugin.config) }),
    ...(plugin.configSchema === undefined ? {} : { configSchema: immutable(plugin.configSchema) }),
    ...(plugin.provides === undefined ? {} : { provides: Object.freeze([...plugin.provides]) }),
    ...(plugin.requires === undefined ? {} : { requires: Object.freeze(plugin.requires.map((entry) => Object.freeze({
      ...entry, ...(entry.capabilities ? { capabilities: Object.freeze([...entry.capabilities]) } : {}),
    }))) }),
    ...(plugin.optional === undefined ? {} : { optional: Object.freeze(plugin.optional.map((entry) => Object.freeze({
      ...entry, ...(entry.capabilities ? { capabilities: Object.freeze([...entry.capabilities]) } : {}),
    }))) }),
    ...(plugin.requiresHooks === undefined ? {} : { requiresHooks: Object.freeze([...plugin.requiresHooks]) }),
    ...(plugin.state === undefined ? {} : { state: Object.freeze({
      ...plugin.state, initial: immutable(plugin.state.initial),
      ...(plugin.state.schema === undefined ? {} : { schema: immutable(plugin.state.schema) }),
    }) }),
  });
  pluginSources.set(snapshot, plugin);
  return snapshot;
}

export function validateJson(value: unknown, label: string): void {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || !isDeepStrictEqual(value, JSON.parse(encoded))) {
    throw new TypeError(`${label} must contain JSON values`);
  }
}

export function validateGraph(
  plugins: readonly AnyPlugin[],
  bindings: readonly ServiceBinding[],
  hooks: readonly HookDefinition<unknown>[],
): readonly AnyPlugin[] {
  const ids = new Set<string>();
  const providers = new Map<string, { token: ServiceToken; plugin?: AnyPlugin }>();
  const hooksByName = new Map<string, HookDefinition<unknown>>();
  for (const hook of hooks) {
    if (hooksByName.has(hook.name)) throw new Error(`Duplicate hook definition: ${hook.name}`);
    if (hook.kind === "transform" && hook.failure === "isolate") {
      throw new Error(`Transformation hook cannot isolate failures: ${hook.name}`);
    }
    hooksByName.set(hook.name, hook);
  }
  for (const binding of bindings) {
    validateToken(binding.service);
    const key = `${binding.service.scope}:${binding.service.id}`;
    if (providers.has(key)) throw new Error(`Duplicate service provider: ${key}`);
    providers.set(key, { token: binding.service });
  }
  for (const plugin of plugins) {
    if (!plugin.id.trim() || ids.has(plugin.id)) throw new Error(`Duplicate or empty plugin id: ${plugin.id}`);
    ids.add(plugin.id);
    if (!valid(plugin.version)) throw new Error(`Invalid plugin version: ${plugin.id}`);
    if (typeof plugin.setup !== "function") throw new Error(`Plugin ${plugin.id} must define setup`);
    scopeIndex(pluginScope(plugin));
    validateSchema(plugin.configSchema, plugin.config, `Invalid configuration for ${plugin.id}`);
    if (plugin.state) {
      if (!Number.isSafeInteger(plugin.state.version) || plugin.state.version < 1) {
        throw new Error(`Invalid state version for ${plugin.id}`);
      }
      if (plugin.state.compatibleVersions && !validRange(plugin.state.compatibleVersions)) {
        throw new Error(`Invalid state compatibility range for ${plugin.id}`);
      }
      validateSchema(plugin.state.schema, plugin.state.initial, `Invalid initial state for ${plugin.id}`);
      validateJson(plugin.state.initial, `Initial state for ${plugin.id}`);
    }
    for (const hook of plugin.requiresHooks ?? []) {
      const available = hooksByName.get(hook.name);
      if (!available || available.kind !== hook.kind) throw new Error(`Plugin ${plugin.id} requires hook ${hook.name}`);
    }
    for (const token of plugin.provides ?? []) {
      validateToken(token);
      if (token.scope !== pluginScope(plugin)) {
        throw new Error(`Plugin ${plugin.id} cannot provide ${token.id} in scope ${token.scope}`);
      }
      const key = `${token.scope}:${token.id}`;
      if (providers.has(key)) throw new Error(`Duplicate service provider: ${key}`);
      providers.set(key, { token, plugin });
    }
  }
  const edges = new Map<AnyPlugin, AnyPlugin[]>();
  for (const plugin of plugins) {
    const dependencies: AnyPlugin[] = [];
    const seen = new Set<string>();
    for (const [required, declared] of [[true, plugin.requires], [false, plugin.optional]] as const) {
      for (const dependency of declared ?? []) {
        validateToken(dependency.service);
        const { service, version = service.version, capabilities = [] } = dependency;
        const key = `${service.scope}:${service.id}`;
        if (seen.has(key)) throw new Error(`Duplicate dependency ${service.id} in plugin ${plugin.id}`);
        seen.add(key);
        if (!validRange(version)) throw new Error(`Invalid dependency version range for ${plugin.id}: ${service.id}`);
        if (scopeIndex(service.scope) > scopeIndex(pluginScope(plugin))) {
          throw new Error(`Plugin ${plugin.id} cannot depend on shorter scope service ${service.id}`);
        }
        const provider = providers.get(key);
        if (!provider) {
          if (required) throw new Error(`Plugin ${plugin.id} requires missing service ${service.id}`);
          continue;
        }
        if (!satisfies(provider.token.version, version)) {
          throw new Error(`Incompatible service ${service.id} for plugin ${plugin.id}: ${provider.token.version} does not satisfy ${version}`);
        }
        for (const capability of [...service.capabilities, ...capabilities]) {
          if (!provider.token.capabilities.includes(capability)) {
            throw new Error(`Service ${service.id} lacks capability ${capability} required by ${plugin.id}`);
          }
        }
        if (provider.plugin) dependencies.push(provider.plugin);
      }
    }
    edges.set(plugin, dependencies);
  }
  const visiting = new Set<AnyPlugin>();
  const visited = new Set<AnyPlugin>();
  const ordered: AnyPlugin[] = [];
  const visit = (plugin: AnyPlugin): void => {
    if (visited.has(plugin)) return;
    if (visiting.has(plugin)) throw new Error(`Circular plugin dependency involving ${plugin.id}`);
    visiting.add(plugin);
    for (const dependency of edges.get(plugin) ?? []) visit(dependency);
    visiting.delete(plugin);
    visited.add(plugin);
    ordered.push(plugin);
  };
  for (const plugin of plugins) visit(plugin);
  return ordered;
}
