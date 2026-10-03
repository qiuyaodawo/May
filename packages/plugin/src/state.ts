import { satisfies, valid } from "semver";
import type { AnyPlugin, PluginState, PluginStateRecord, PluginStateSnapshot } from "./types.js";
import { validateJson, validateSchema } from "./validation.js";

export class StateStore {
  private entries: Record<string, PluginStateRecord>;
  private pending: Promise<void> = Promise.resolve();

  constructor(snapshot: PluginStateSnapshot, private readonly save?: (snapshot: PluginStateSnapshot) => Promise<void>) {
    validateSchema({ type: "object", additionalProperties: { type: "object", properties: {
      pluginVersion: { type: "string" }, stateVersion: { type: "integer", minimum: 1 }, value: {},
    }, required: ["pluginVersion", "stateVersion", "value"], additionalProperties: false } }, snapshot, "Invalid plugin state snapshot");
    validateJson(snapshot, "Plugin state");
    for (const [id, record] of Object.entries(snapshot)) {
      if (!valid(record.pluginVersion)) throw new Error(`Invalid stored plugin version for ${id}`);
    }
    this.entries = structuredClone(snapshot);
  }

  snapshot(): PluginStateSnapshot {
    return structuredClone(this.entries);
  }

  async prepare(plugin: AnyPlugin): Promise<void> {
    if (!plugin.state) return;
    const definition = plugin.state;
    const previous = Object.hasOwn(this.entries, plugin.id) ? this.entries[plugin.id] : undefined;
    const compatible = previous && previous.stateVersion === definition.version &&
      satisfies(previous.pluginVersion, definition.compatibleVersions ?? plugin.version);
    const value = !previous ? structuredClone(definition.initial) : compatible ? previous.value :
      definition.migrate ? await definition.migrate(structuredClone(previous)) : undefined;
    if (previous && !compatible && !definition.migrate) {
      throw new Error(`Plugin ${plugin.id} cannot restore state version ${previous.stateVersion} from plugin ${previous.pluginVersion}`);
    }
    await this.write(plugin, value);
  }

  forPlugin(plugin: AnyPlugin, assertActive: () => void): PluginState {
    const ensure = (): void => {
      assertActive();
      if (!plugin.state) throw new Error(`Plugin ${plugin.id} did not declare persistent state`);
    };
    return {
      get: <T>(): T => {
        ensure();
        return structuredClone(this.entries[plugin.id]!.value) as T;
      },
      set: async (value) => {
        ensure();
        await this.enqueue(() => { ensure(); return this.write(plugin, value); });
      },
      update: async (update) => {
        ensure();
        await this.enqueue(async () => {
          ensure();
          const value = await update(structuredClone(this.entries[plugin.id]!.value));
          ensure();
          await this.write(plugin, value);
        });
      },
    };
  }

  async settled(): Promise<void> {
    await this.pending;
  }

  private async write(plugin: AnyPlugin, value: unknown): Promise<void> {
    validateJson(value, "Plugin state");
    validateSchema(plugin.state!.schema, value, `Invalid state for ${plugin.id}`);
    const record = { pluginVersion: plugin.version, stateVersion: plugin.state!.version, value: structuredClone(value) };
    const next = { ...this.entries, [plugin.id]: record };
    await this.save?.(structuredClone(next));
    this.entries = next;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const operation = this.pending.then(task);
    this.pending = operation.catch(() => {});
    return operation;
  }
}
