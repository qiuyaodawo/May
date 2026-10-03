import type { HookContext, HookDefinition } from "@may/core";
import type { Disposer, HookHandler, HookHandlerOptions } from "./types.js";

export interface HookRegistration {
  readonly pluginId: string;
  readonly pluginOrder: number;
  readonly registrationOrder: number;
  readonly hook: HookDefinition<unknown>;
  readonly handler: HookHandler<unknown>;
  readonly options: HookHandlerOptions;
  readonly signal: AbortSignal;
}

export function immutable<T>(value: T): Readonly<T> {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== "object" || Object.isFrozen(item)) return;
    Object.freeze(item);
    for (const child of Object.values(item)) freeze(child);
  };
  freeze(copy);
  return copy;
}

export class HookRegistry {
  private readonly entries = new Set<HookRegistration>();
  private sequence = 0;

  add<T>(
    pluginId: string,
    pluginOrder: number,
    hook: HookDefinition<T>,
    handler: HookHandler<T>,
    options: HookHandlerOptions,
    signal: AbortSignal,
  ): Disposer {
    if (!Number.isFinite(options.order ?? 0)) throw new Error(`Invalid hook order for ${pluginId}`);
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new Error(`Invalid hook timeout for ${pluginId}`);
    }
    const entry: HookRegistration = {
      pluginId, pluginOrder, registrationOrder: this.sequence++, hook,
      handler: handler as HookHandler<unknown>, options: Object.freeze({ ...options }), signal,
    };
    this.entries.add(entry);
    return () => { this.entries.delete(entry); };
  }

  forHook(name: string): readonly HookRegistration[] {
    return [...this.entries].filter((entry) => entry.hook.name === name);
  }
}

export function orderHandlers(entries: readonly HookRegistration[]): readonly HookRegistration[] {
  return [...entries].sort((left, right) =>
    (left.options.order ?? 0) - (right.options.order ?? 0) ||
    left.pluginOrder - right.pluginOrder || left.registrationOrder - right.registrationOrder);
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Plugin operation failed", { cause: error });
}

export async function withDeadline<T>(
  operation: (signal: AbortSignal) => T | Promise<T>,
  parent: AbortSignal,
  timeoutMs: number,
  label: string,
  track: (pending: Promise<unknown>, cancel: Disposer) => void,
): Promise<T> {
  parent.throwIfAborted();
  const deadline = new AbortController();
  const signal = AbortSignal.any([parent, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    listener = () => reject(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
  });
  const task = Promise.resolve().then(() => { signal.throwIfAborted(); return operation(signal); });
  track(task, () => deadline.abort(new Error(`${label} cancelled`)));
  try {
    return await Promise.race([task, aborted]);
  } finally {
    clearTimeout(timer);
    if (listener) signal.removeEventListener("abort", listener);
  }
}

export function handlerContext(context: HookContext, signal: AbortSignal): HookContext {
  return { ...context, signal: AbortSignal.any([signal, context.signal]) };
}
