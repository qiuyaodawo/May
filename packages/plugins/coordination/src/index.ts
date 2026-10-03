import { CoordinationRuntime, type CreateCoordinationOptions, type CoordinationRuntimeOptions } from "@may/coordination";
import { definePlugin, defineService, type PluginDefinition } from "@may/plugin";

export interface CoordinationService {
  create(options: CreateCoordinationOptions): Promise<CoordinationRuntime>;
  resume(options: CoordinationRuntimeOptions): Promise<CoordinationRuntime>;
  release(runtime: CoordinationRuntime): Promise<void>;
}
export const coordinationService = defineService<CoordinationService>({ id: "may.coordination", version: "1.0.0", scope: "host" });
export function createCoordinationPlugin(options: { readonly id?: string } = {}): PluginDefinition {
  return definePlugin({
    id: options.id ?? "@may/plugin-coordination", version: "0.1.0", scope: "host", provides: [coordinationService],
    setup(context) {
      const runtimes = new Set<CoordinationRuntime>();
      const pending = new Set<Promise<CoordinationRuntime>>();
      const manage = (operation: () => Promise<CoordinationRuntime>): Promise<CoordinationRuntime> => {
        context.signal.throwIfAborted();
        const opening = operation().then(async runtime => {
          if (context.signal.aborted) { await runtime.close(); context.signal.throwIfAborted(); }
          runtimes.add(runtime); return runtime;
        }).finally(() => pending.delete(opening));
        pending.add(opening); return opening;
      };
      context.provide(coordinationService, {
        create: options_ => manage(() => CoordinationRuntime.create(options_)),
        resume: options_ => manage(() => CoordinationRuntime.resume(options_)),
        release: async runtime => { await runtime.close(); runtimes.delete(runtime); },
      });
      context.defer(async () => {
        await Promise.allSettled(pending);
        const results = await Promise.allSettled([...runtimes].map(runtime => runtime.close()));
        const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, "Coordination cleanup failed");
      });
    },
  });
}
