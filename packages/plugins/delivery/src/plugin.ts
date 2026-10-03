import { definePlugin, defineService, type Disposer, type PluginDefinition, type ServiceToken } from "@may/plugin";
import type { ChannelAdapter, ChannelIngress, ChannelRegistry, DeliveryService } from "./types.js";
import { validateChannelInput } from "./store.js";

export const deliveryServices = Object.freeze({
  registry: defineService<ChannelRegistry>({ id: "may.channels.registry", version: "1.0.0", scope: "host" }),
  delivery: defineService<DeliveryService>({ id: "may.delivery", version: "1.0.0", scope: "host" }),
});
export function createDeliveryPlugin(options: { readonly ingress: ServiceToken<ChannelIngress>; readonly id?: string }): PluginDefinition {
  return definePlugin({
    id: options.id ?? "@may/plugin-delivery", version: "0.1.0", scope: "host",
    requires: [{ service: options.ingress }], provides: [deliveryServices.registry, deliveryServices.delivery],
    setup(context) {
      const ingress = context.get(options.ingress);
      const adapters = new Map<string, { adapter: ChannelAdapter; dispose: Disposer }>();
      const failures = new Map<string, unknown>();
      const pending = new Map<string, Promise<unknown>>();
      const registry: ChannelRegistry = {
        register(adapter) {
          context.signal.throwIfAborted();
          if (adapters.has(adapter.account)) throw new Error(`Duplicate channel account: ${adapter.account}`);
          const controller = new AbortController();
          const signal = AbortSignal.any([context.signal, controller.signal]);
          const running = (async () => {
            if (ingress.ready) await readyOrAbort(ingress.ready, signal);
            signal.throwIfAborted();
            await adapter.run(async input => { validateChannelInput(input); await ingress.receive(input); }, ingress.store, signal);
          })();
          let failure: unknown;
          const done = running.catch(async error => {
            if (signal.aborted) return;
            failure = error; failures.set(adapter.account, error);
            try { await ingress.onError?.(adapter.account, error); }
            catch (reportError) {
              failure = new AggregateError([error, reportError], "Channel operation and error reporting failed");
              failures.set(adapter.account, failure);
            }
          });
          let disposed: Promise<void> | undefined;
          const dispose = () => disposed ??= (async () => {
            controller.abort(new Error("Channel plugin is closing"));
            await done; adapters.delete(adapter.account); failures.delete(adapter.account);
            if (failure !== undefined) throw failure;
          })();
          adapters.set(adapter.account, { adapter, dispose });
          return dispose;
        },
        get: account => adapters.get(account)?.adapter,
        list: () => [...adapters.values()].map(value => value.adapter),
        errors: () => new Map(failures),
      };
      const delivery: DeliveryService = {
        attempt(adapter, record, options_) {
          context.signal.throwIfAborted();
          if (pending.has(record.id)) throw new Error(`Delivery is already active: ${record.id}`);
          if (record.status !== "pending" || record.account !== adapter.account) throw new Error("Delivery does not belong to a pending channel operation");
          const signal = AbortSignal.any([context.signal, options_.signal]);
          const operation = (async () => {
            signal.throwIfAborted();
            await options_.commit("sending");
            try {
              signal.throwIfAborted();
              const receipt = await adapter.send(record, signal, options_.image);
              await options_.commit("sent", receipt ?? undefined);
              return receipt;
            } catch (error) {
              try { await options_.commit("unknown"); }
              catch (persistenceError) { throw new AggregateError([error, persistenceError], "Delivery outcome and persistence failed"); }
              throw error;
            }
          })().finally(() => pending.delete(record.id));
          pending.set(record.id, operation); return operation;
        },
      };
      context.provide(deliveryServices.registry, registry); context.provide(deliveryServices.delivery, delivery);
      context.defer(async () => {
        const results = await Promise.allSettled([...adapters.values()].map(value => value.dispose()).concat([...pending.values()].map(async value => { await value; })));
        const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, "Channel and delivery cleanup failed");
      });
    },
  });
}
async function readyOrAbort(ready: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    await Promise.race([ready, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener("abort", abort); }
}
