import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { resolve } from "import-meta-resolve";
import type { AnyPlugin } from "./types.js";

export interface PluginModuleSelection {
  readonly module: string;
  readonly export?: string;
  readonly config?: unknown;
  readonly enabled?: boolean;
}

export function parsePluginSelections(value: unknown): readonly PluginModuleSelection[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("Plugin selections must be an array");
  return value.map((entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError("A plugin selection must be an object");
    }
    const item = entry as Record<string, unknown>;
    if (Object.keys(item).some((key) => !["module", "export", "config", "enabled"].includes(key))) {
      throw new TypeError("Unknown plugin selection field");
    }
    if (typeof item.module !== "string" || item.module.trim().length === 0) {
      throw new TypeError("Plugin module must be a non-empty string");
    }
    if (item.export !== undefined && (typeof item.export !== "string" || item.export.length === 0)) {
      throw new TypeError("Plugin export must be a non-empty string");
    }
    if (item.enabled !== undefined && typeof item.enabled !== "boolean") {
      throw new TypeError("Plugin enabled must be a boolean");
    }
    return Object.freeze({
      module: item.module,
      ...(item.export === undefined ? {} : { export: item.export as string }),
      ...(item.enabled === undefined ? {} : { enabled: item.enabled as boolean }),
      ...(item.config === undefined ? {} : { config: structuredClone(item.config) }),
    });
  });
}

/** 模块按照配置文件位置解析，加载期间由模块自身遵守资源初始化规则。 */
export async function loadPluginModules(
  selections: readonly PluginModuleSelection[],
  parent: string | URL,
): Promise<readonly AnyPlugin[]> {
  const entries = parsePluginSelections(selections);
  const base = parent instanceof URL ? parent : parent.startsWith("file:") ? new URL(parent) : pathToFileURL(parent);
  if (base.protocol !== "file:") throw new TypeError("Plugin parent must be a local file URL");
  const loaded: AnyPlugin[] = [];
  for (const entry of entries) {
    if (entry.enabled === false) continue;
    const specifier = isAbsolute(entry.module) ? pathToFileURL(entry.module).href : entry.module;
    const resolved = new URL(resolve(specifier, base.href));
    if (resolved.protocol !== "file:") throw new TypeError("Plugin modules must resolve to local files");
    const exports = await import(resolved.href) as Record<string, unknown>;
    const definition = exports[entry.export ?? "default"];
    if (definition === null || typeof definition !== "object" || Array.isArray(definition)) {
      throw new TypeError("Plugin module must export a PluginDefinition object");
    }
    const candidate = definition as AnyPlugin;
    if (typeof candidate.id !== "string" || typeof candidate.version !== "string" || typeof candidate.setup !== "function") {
      throw new TypeError("Plugin module has an incomplete definition");
    }
    loaded.push(Object.freeze({
      ...candidate,
      ...(entry.config === undefined ? {} : { config: structuredClone(entry.config) }),
    }));
  }
  return Object.freeze(loaded);
}
