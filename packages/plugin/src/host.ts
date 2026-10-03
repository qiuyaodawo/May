import type { HookContext, HookDefinition, HookDispatcher } from "@may/core";
import { satisfies } from "semver";
import { asError, handlerContext, HookRegistry, immutable, orderHandlers, withDeadline } from "./hooks.js";
import { StateStore } from "./state.js";
import type {
  AnyPlugin, Disposer, PluginChangeOptions, PluginContext, PluginHostOptions,
  PluginOperationOptions, PluginScope, PluginScopeOptions, PluginStateSnapshot,
  ServiceBinding, ServiceToken,
} from "./types.js";
import { pluginScope, pluginSource, scopeIndex, snapshotPlugin, validateGraph } from "./validation.js";

interface PluginInstance {
  readonly definition: AnyPlugin;
  readonly controller: AbortController;
  readonly disposers: Disposer[];
}

interface Operation {
  readonly pending: Promise<unknown>;
  readonly cancel?: Disposer;
}

export class PluginHost implements HookDispatcher {
  readonly kind: PluginScope;
  readonly id: string;
  private definitions: readonly AnyPlugin[];
  private ordered: readonly AnyPlugin[];
  private readonly bindingTemplates: readonly ServiceBinding[];
  private readonly instances: PluginInstance[] = [];
  private readonly services = new Map<string, ServiceBinding>();
  private readonly children = new Set<PluginHost>();
  private readonly registry = new HookRegistry();
  private readonly controller = new AbortController();
  private readonly active = new Set<Operation>();
  private readonly stateStore: StateStore;
  private readonly hooks: ReadonlyMap<string, HookDefinition<unknown>>;
  private closed = false;
  private ready = false;
  private changing = false;
  private changeCount = 0;
  private changeQueue: Promise<void> = Promise.resolve();
  private closeResult: Promise<void> | undefined;
  private initializationSignal: AbortSignal | undefined;

  private constructor(
    private readonly options: PluginHostOptions,
    kind: PluginScope,
    id: string,
    private readonly parent?: PluginHost,
    scopeOptions?: PluginScopeOptions,
  ) {
    this.kind = kind;
    this.id = id;
    this.initializationSignal = scopeOptions?.signal;
    this.definitions = parent?.definitions ?? options.plugins.map(snapshotPlugin);
    this.bindingTemplates = [
      ...(parent?.bindingTemplates ?? options.services ?? []), ...(scopeOptions?.services ?? []),
    ].map((binding) => Object.freeze({ ...binding }));
    this.ordered = validateGraph(this.definitions, this.bindingTemplates, options.hooks ?? []);
    this.hooks = new Map((options.hooks ?? []).map((hook) => [hook.name, hook]));
    this.stateStore = new StateStore(
      scopeOptions?.state ?? (parent ? {} : options.state ?? {}),
      scopeOptions?.onStateChange ?? (parent ? undefined : options.onStateChange),
    );
  }

  static async create(options: PluginHostOptions): Promise<PluginHost> {
    const timeout = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Plugin timeoutMs must be positive and finite");
    const host = new PluginHost(Object.freeze({
      ...options, timeoutMs: timeout,
      plugins: Object.freeze([...options.plugins]),
      hooks: Object.freeze([...(options.hooks ?? [])]),
      services: Object.freeze((options.services ?? []).map((binding) => Object.freeze({ ...binding }))),
    }), "host", "host");
    options.signal?.throwIfAborted();
    await host.start();
    if (options.signal) {
      const onAbort = (): void => {
        host.controller.abort(options.signal!.reason);
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      host.externalCleanup = () => options.signal!.removeEventListener("abort", onAbort);
    }
    return host;
  }

  private externalCleanup: Disposer | undefined;

  get plugins(): readonly AnyPlugin[] {
    return [...this.definitions];
  }

  get isReady(): boolean {
    return this.chain().every((scope) => scope.ready && !scope.closed && !scope.changing && !scope.signal.aborted);
  }

  get signal(): AbortSignal {
    const signals = this.chain().map((scope) => scope.controller.signal);
    if (this.options.signal) signals.push(this.options.signal);
    return AbortSignal.any(signals);
  }

  async createScope(kind: Exclude<PluginScope, "host">, options: PluginScopeOptions): Promise<PluginHost> {
    this.assertReady();
    this.assertNotChanging();
    if (scopeIndex(kind) !== scopeIndex(this.kind) + 1) {
      throw new Error(`Scope ${kind} must follow ${this.kind}`);
    }
    if (!options.id.trim()) throw new Error("Scope id must not be empty");
    for (const child of this.children) {
      if (!child.closed && child.id === options.id) throw new Error(`Duplicate ${kind} scope id: ${options.id}`);
    }
    const child = new PluginHost(this.options, kind, options.id, this, options);
    this.children.add(child);
    try {
      await this.use(() => child.start(), { cancel: () => { child.controller.abort(new Error("Scope creation cancelled")); } });
      return child;
    } catch (error) {
      this.children.delete(child);
      throw error;
    }
  }

  provides(service: ServiceToken): boolean {
    return this.find(service) !== undefined;
  }

  get<T>(service: ServiceToken<T>): T {
    this.assertReady();
    const binding = this.find(service);
    if (!binding) throw new Error(`Service ${service.id} is not ready in ${this.kind} scope ${this.id}`);
    return binding.value as T;
  }

  snapshotState(): PluginStateSnapshot {
    return this.stateStore.snapshot();
  }

  async use<T>(operation: () => T | Promise<T>, options: PluginOperationOptions = {}): Promise<T> {
    const chain = this.chain();
    for (const scope of chain) { scope.assertReady(); scope.assertNotChanging(); }
    const pending = Promise.resolve().then(operation);
    const entry: Operation = { pending, ...options };
    for (const scope of chain) scope.active.add(entry);
    try {
      return await pending;
    } finally {
      for (const scope of chain) scope.active.delete(entry);
    }
  }

  transform<T>(hook: HookDefinition<T>, value: T, context: HookContext): Promise<T> {
    return this.dispatch((signal) => this.transformValue(hook, value, context, signal));
  }

  private async transformValue<T>(hook: HookDefinition<T>, value: T, context: HookContext, cancellation: AbortSignal): Promise<T> {
    const canonical = this.resolveHook(hook, "transform");
    if (!canonical.allowAborted) context.signal.throwIfAborted();
    let current = canonical.validate(structuredClone(value));
    for (const registration of this.handlers(hook.name)) {
      const parentSignal = AbortSignal.any([registration.signal, cancellation,
        ...(canonical.allowAborted ? [] : [context.signal])]);
      const result = await withDeadline(
        (signal) => registration.handler(immutable(current), handlerContext(context, signal)),
        parentSignal, registration.options.timeoutMs ?? this.options.timeoutMs!,
        `Hook ${hook.name} in plugin ${registration.pluginId}`, (task, cancel) => this.track(task, cancel),
      );
      if (result !== undefined) current = canonical.validate(structuredClone(result));
    }
    return current as T;
  }

  observe<T>(hook: HookDefinition<T>, value: T, context: HookContext): Promise<void> {
    return this.dispatch((signal) => this.observeValue(hook, value, context, signal));
  }

  private async observeValue<T>(hook: HookDefinition<T>, value: T, context: HookContext, cancellation: AbortSignal): Promise<void> {
    const canonical = this.resolveHook(hook, "observe");
    if (!canonical.allowAborted) context.signal.throwIfAborted();
    const current = canonical.validate(structuredClone(value));
    for (const registration of this.handlers(hook.name)) {
      const parentSignal = AbortSignal.any([registration.signal, cancellation,
        ...(canonical.allowAborted ? [] : [context.signal])]);
      try {
        const result = await withDeadline(
          (signal) => registration.handler(immutable(current), handlerContext(context, signal)),
          parentSignal, registration.options.timeoutMs ?? this.options.timeoutMs!,
          `Hook ${hook.name} in plugin ${registration.pluginId}`, (task, cancel) => this.track(task, cancel),
        );
        if (result !== undefined) throw new Error(`Observation hook ${hook.name} cannot return a replacement`);
      } catch (error) {
        if ((registration.options.failure ?? canonical.failure ?? "propagate") !== "isolate" ||
            registration.signal.aborted || cancellation.aborted || (!canonical.allowAborted && context.signal.aborted)) throw error;
        if (!this.options.onHookError) throw new Error(`Hook ${hook.name} isolation requires onHookError`, { cause: error });
        await withDeadline(
          (signal) => this.options.onHookError!(asError(error), canonical, registration.pluginId, handlerContext(context, signal)),
          parentSignal, registration.options.timeoutMs ?? this.options.timeoutMs!,
          `Hook ${hook.name} error reporter`, (task, cancel) => this.track(task, cancel),
        );
      }
    }
  }

  replacePlugins(plugins: readonly AnyPlugin[], options: PluginChangeOptions = {}): Promise<void> {
    return this.enqueueChange(() => plugins, options);
  }

  validatePlugins(plugins: readonly AnyPlugin[]): void {
    if (this.closed) throw new Error(`Plugin scope ${this.id} is closed`);
    this.signal.throwIfAborted();
    this.prepareChange(plugins);
  }

  replace(plugin: AnyPlugin, options: PluginChangeOptions = {}): Promise<void> {
    return this.enqueueChange(() => {
      const index = this.definitions.findIndex((entry) => entry.id === plugin.id);
      const next = [...this.definitions];
      if (index < 0) next.push(plugin); else next[index] = plugin;
      return next;
    }, options);
  }

  remove(id: string, options: PluginChangeOptions = {}): Promise<void> {
    return this.enqueueChange(() => {
      if (!this.definitions.some((plugin) => plugin.id === id)) throw new Error(`Unknown plugin: ${id}`);
      const removed = new Set([id]);
      let updated = true;
      while (updated) {
        updated = false;
        const services = new Set(this.definitions.filter((plugin) => removed.has(plugin.id))
          .flatMap((plugin) => (plugin.provides ?? []).map((token) => `${token.scope}:${token.id}`)));
        for (const plugin of this.definitions) {
          if (!removed.has(plugin.id) && (plugin.requires ?? []).some(({ service }) => services.has(`${service.scope}:${service.id}`))) {
            removed.add(plugin.id);
            updated = true;
          }
        }
      }
      return this.definitions.filter((plugin) => !removed.has(plugin.id));
    }, options);
  }

  updateConfig(id: string, config: unknown, options: PluginChangeOptions = {}): Promise<void> {
    return this.enqueueChange(() => {
      if (!this.definitions.some((plugin) => plugin.id === id)) throw new Error(`Unknown plugin: ${id}`);
      return this.definitions.map((plugin) => plugin.id === id ? { ...plugin, config } : plugin);
    }, options);
  }

  close(): Promise<void> {
    if (this.closeResult) return this.closeResult;
    this.closed = true;
    this.ready = false;
    this.controller.abort(new Error(`Plugin scope ${this.id} closed`));
    this.closeResult = this.finishClose();
    return this.closeResult;
  }

  private async finishClose(): Promise<void> {
    const errors: unknown[] = [];
    try { await this.cancelActive(); } catch (error) { errors.push(error); }
    for (const child of [...this.children].reverse()) {
      try { await child.close(); } catch (error) { errors.push(error); }
    }
    await this.idle();
    await this.changeQueue;
    try { await this.stop(); } catch (error) { errors.push(error); }
    try { await this.stateStore.settled(); } catch (error) { errors.push(error); }
    await this.externalCleanup?.();
    this.parent?.children.delete(this);
    if (errors.length) throw new AggregateError(errors, `Failed to close plugin scope ${this.id}`);
  }

  private async start(): Promise<void> {
    AbortSignal.any([this.signal, ...(this.initializationSignal ? [this.initializationSignal] : [])]).throwIfAborted();
    this.ready = false;
    for (const binding of this.bindingTemplates) {
      if (binding.service.scope === this.kind) this.services.set(binding.service.id, binding);
    }
    const local = this.ordered.filter((plugin) => pluginScope(plugin) === this.kind);
    try {
      for (const plugin of local) await this.stateStore.prepare(plugin);
      for (const plugin of local) await this.startPlugin(plugin);
      this.signal.throwIfAborted();
      this.ready = true;
      this.initializationSignal = undefined;
    } catch (error) {
      await this.cancelActive();
      await this.idle();
      try { await this.stop(); } catch (cleanup) {
        throw new AggregateError([error, cleanup], `Plugin initialization and cleanup failed in scope ${this.id}`, { cause: error });
      }
      throw error;
    }
  }

  private async startPlugin(plugin: AnyPlugin): Promise<void> {
    const instance: PluginInstance = { definition: plugin, controller: new AbortController(), disposers: [] };
    this.instances.push(instance);
    const assertActive = (): void => {
      this.signal.throwIfAborted();
      instance.controller.signal.throwIfAborted();
    };
    const declared = (service: ServiceToken, optional: boolean) => {
      const entries = optional ? plugin.optional ?? [] : [...(plugin.requires ?? []), ...(plugin.optional ?? [])];
      const dependency = entries.find((dependency) => dependency.service.id === service.id && dependency.service.scope === service.scope);
      if (!dependency) {
        throw new Error(`Plugin ${plugin.id} did not declare dependency ${service.id}`);
      }
      return dependency;
    };
    try {
      await withDeadline(async (signal) => {
        const context: PluginContext = {
          pluginId: plugin.id, pluginOrder: this.definitions.indexOf(plugin), scope: this.kind, scopeId: this.id, config: immutable(plugin.config), signal,
          state: this.stateStore.forPlugin(plugin, assertActive),
          get: <T>(service: ServiceToken<T>): T => {
            assertActive(); const dependency = declared(service, false);
            const binding = this.find(service, dependency.version ?? dependency.service.version);
            if (!binding) throw new Error(`Dependency ${service.id} is not ready for ${plugin.id}`);
            return binding.value as T;
          },
          optional: <T>(service: ServiceToken<T>): T | undefined => {
            assertActive(); const dependency = declared(service, true);
            return this.find(service, dependency.version ?? dependency.service.version)?.value as T | undefined;
          },
          provide: <T>(service: ServiceToken<T>, value: T): void => {
            assertActive();
            const token = (plugin.provides ?? []).find((candidate) => candidate.id === service.id);
            if (!token || token !== service) throw new Error(`Plugin ${plugin.id} did not declare provided service ${service.id}`);
            if (this.services.has(service.id)) throw new Error(`Service ${service.id} is already registered`);
            if (value === undefined || value === null) throw new Error(`Service ${service.id} must provide an instance`);
            this.services.set(service.id, { service, value });
            instance.disposers.push(() => { this.services.delete(service.id); });
          },
          on: (hook, handler, options = {}): Disposer => {
            assertActive();
            const canonical = this.resolveHook(hook, hook.kind);
            const failure = options.failure ?? canonical.failure;
            if (canonical.kind === "transform" && failure === "isolate") throw new Error(`Transformation hook ${hook.name} cannot isolate failures`);
            if (failure === "isolate" && !this.options.onHookError) throw new Error(`Hook ${hook.name} isolation requires onHookError`);
            const unsubscribe = this.registry.add(plugin.id, this.definitions.indexOf(plugin), hook, handler, options,
              AbortSignal.any([this.signal, instance.controller.signal]));
            instance.disposers.push(unsubscribe);
            return unsubscribe;
          },
          defer: (cleanup): void => {
            if (typeof cleanup !== "function") throw new TypeError(`Plugin ${plugin.id} cleanup must be a function`);
            instance.disposers.push(cleanup);
          },
        };
        const dispose = await plugin.setup(context);
        if (dispose !== undefined && typeof dispose !== "function") throw new TypeError(`Plugin ${plugin.id} setup must return a cleanup function or undefined`);
        if (dispose) instance.disposers.push(dispose);
      }, AbortSignal.any([this.signal, instance.controller.signal,
        ...(this.initializationSignal ? [this.initializationSignal] : [])]), this.options.timeoutMs!,
      `Plugin ${plugin.id} setup`, (task, cancel) => this.track(task, cancel));
      for (const token of plugin.provides ?? []) {
        if (!this.services.has(token.id)) throw new Error(`Plugin ${plugin.id} did not initialize service ${token.id}`);
      }
    } catch (error) {
      instance.controller.abort(error);
      throw new Error(`Plugin ${plugin.id} initialization failed`, { cause: error });
    }
  }

  private async stop(): Promise<void> {
    const errors: unknown[] = [];
    for (const instance of this.instances.splice(0).reverse()) {
      instance.controller.abort(new Error(`Plugin ${instance.definition.id} unloaded`));
      for (const dispose of instance.disposers.reverse()) {
        try { await dispose(); } catch (error) {
          errors.push(new Error(`Plugin ${instance.definition.id} cleanup failed`, { cause: error }));
        }
      }
    }
    this.services.clear();
    this.ready = false;
    if (errors.length) throw new AggregateError(errors, `Plugin cleanup failed in scope ${this.id}`);
  }

  private find(service: ServiceToken, version = service.version): ServiceBinding | undefined {
    const scope = this.chain().find((candidate) => candidate.kind === service.scope);
    const binding = scope?.services.get(service.id);
    if (!binding) return undefined;
    if (!satisfies(binding.service.version, version)) throw new Error(`Incompatible service token ${service.id}`);
    return binding;
  }

  private chain(): PluginHost[] {
    return this.parent ? [...this.parent.chain(), this] : [this];
  }

  private handlers(name: string) {
    for (const scope of this.chain()) scope.assertReady();
    return orderHandlers(this.chain().flatMap((scope) => scope.registry.forHook(name)));
  }

  private resolveHook<T>(hook: HookDefinition<T>, kind: "transform" | "observe"): HookDefinition<unknown> {
    const canonical = this.hooks.get(hook.name);
    if (!canonical || canonical.kind !== kind || hook.kind !== kind) throw new Error(`Hook ${hook.name} is unavailable as ${kind}`);
    return canonical;
  }

  private assertReady(): void {
    if (this.closed) throw new Error(`Plugin scope ${this.id} is closed`);
    this.signal.throwIfAborted();
    if (!this.ready) throw new Error(`Plugin scope ${this.id} is not ready`);
  }

  private assertNotChanging(): void {
    if (this.changing || this.changeCount) throw new Error(`Plugin scope ${this.id} is changing`);
  }

  private track(pending: Promise<unknown>, cancel: Disposer): void {
    const operation = { pending, cancel };
    for (const scope of this.chain()) scope.active.add(operation);
    void pending.then(() => this.untrack(operation), () => this.untrack(operation));
  }

  private dispatch<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const cancellation = new AbortController();
    const pending = Promise.resolve().then(() => operation(cancellation.signal));
    this.track(pending, () => cancellation.abort(new Error(`Hook dispatch cancelled in scope ${this.id}`)));
    return pending;
  }

  private untrack(operation: Operation): void {
    for (const scope of this.chain()) scope.active.delete(operation);
  }

  private async idle(): Promise<void> {
    while (this.active.size) await Promise.allSettled([...this.active].map(({ pending }) => pending));
  }

  private async cancelActive(): Promise<void> {
    const errors: unknown[] = [];
    for (const { cancel } of [...this.active]) {
      try { await cancel?.(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, `Cancellation failed in plugin scope ${this.id}`);
  }

  private descendants(): PluginHost[] {
    return [this, ...[...this.children].flatMap((child) => child.descendants())];
  }

  private prepareChange(next: readonly AnyPlugin[]) {
    const plugins = next.map((plugin) => {
      const ancestor = this.definitions.find((previous) => previous.id === plugin.id &&
        scopeIndex(pluginScope(previous)) < scopeIndex(this.kind));
      return ancestor && pluginSource(ancestor) === pluginSource(plugin) ? ancestor : snapshotPlugin(plugin);
    });
    const descendants = this.descendants();
    const changedParents = new Set(plugins.filter((plugin) => scopeIndex(pluginScope(plugin)) < scopeIndex(this.kind)));
    const previousParents = this.definitions.filter((plugin) => scopeIndex(pluginScope(plugin)) < scopeIndex(this.kind));
    if (previousParents.length !== changedParents.size || previousParents.some((plugin) => !changedParents.has(plugin))) {
      throw new Error(`Scope ${this.id} cannot change ancestor plugins`);
    }
    const graphs = new Map(descendants.map((scope) => [scope, validateGraph(plugins, scope.bindingTemplates, this.options.hooks ?? [])]));
    return { plugins, descendants, graphs };
  }

  private enqueueChange(create: () => readonly AnyPlugin[], options: PluginChangeOptions): Promise<void> {
    if (this.closed) throw new Error(`Plugin scope ${this.id} is closed`);
    this.signal.throwIfAborted();
    this.changeCount++;
    const root = this.chain()[0]!;
    const operation = root.changeQueue.then(async () => {
      if (this.closed) throw new Error(`Plugin scope ${this.id} is closed`);
      const { plugins, descendants, graphs } = this.prepareChange(create());
      for (const scope of descendants) scope.changing = true;
      try {
        if (options.cancelActive) await this.cancelActive();
        await this.idle();
        if (this.closed) throw new Error(`Plugin scope ${this.id} is closed`);
        for (const scope of [...descendants].reverse()) {
          if (scope.closed) await scope.closeResult;
        }
        const remaining = descendants.filter((scope) => !scope.closed);
        for (const scope of [...remaining].reverse()) await scope.stop();
        for (const scope of remaining) {
          scope.definitions = plugins;
          scope.ordered = graphs.get(scope)!;
          await scope.start();
        }
      } catch (error) {
        const cleanupErrors: unknown[] = [];
        for (const scope of [...descendants].reverse()) {
          try { await scope.stop(); } catch (cleanup) { cleanupErrors.push(cleanup); }
        }
        if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], "Plugin replacement and cleanup failed", { cause: error });
        throw error;
      } finally {
        for (const scope of descendants) scope.changing = false;
      }
    });
    root.changeQueue = operation.catch(() => {});
    return operation.finally(() => { this.changeCount--; });
  }
}
