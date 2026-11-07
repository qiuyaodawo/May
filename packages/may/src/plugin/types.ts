import type { HookContext, HookDefinition, JsonSchema } from "../core/index.js";

/** @experimental */
export type PluginScope = "host" | "application" | "session" | "run";
/** @public */
export type Disposer = () => void | Promise<void>;

/** @experimental */
export interface ServiceToken<T = unknown> {
  readonly id: string;
  readonly version: string;
  readonly scope: PluginScope;
  readonly capabilities: readonly string[];
  readonly valueType?: T;
}

/** @experimental */
export interface ServiceDependency {
  readonly service: ServiceToken;
  readonly version?: string;
  readonly capabilities?: readonly string[];
}

/** @experimental */
export interface ServiceBinding<T = unknown> {
  readonly service: ServiceToken<T>;
  readonly value: T;
}

/** @experimental */
export interface PluginStateRecord {
  readonly pluginVersion: string;
  readonly stateVersion: number;
  readonly value: unknown;
}

/** @experimental */
export type PluginStateSnapshot = Readonly<Record<string, PluginStateRecord>>;

/** @experimental */
export interface PluginStateDefinition {
  readonly version: number;
  readonly schema?: JsonSchema;
  readonly initial: unknown;
  readonly compatibleVersions?: string;
  readonly migrate?: (previous: PluginStateRecord) => unknown | Promise<unknown>;
}

/** @experimental */
export interface PluginState {
  get<T = unknown>(): T;
  set(value: unknown): Promise<void>;
  update(update: (value: unknown) => unknown | Promise<unknown>): Promise<void>;
}

/** @experimental */
export interface HookHandlerOptions {
  readonly order?: number;
  readonly timeoutMs?: number;
  readonly failure?: "propagate" | "isolate";
}

/** @experimental */
export type HookHandler<T> = (value: Readonly<T>, context: HookContext) => T | void | Promise<T | void>;

/** @experimental */
export interface PluginContext<C = unknown> {
  /** @experimental */
  readonly pluginId: string;
  /** @experimental */
  readonly pluginOrder: number;
  /** @experimental */
  readonly scope: PluginScope;
  /** @experimental */
  readonly scopeId: string;
  /** @experimental */
  readonly config: Readonly<C>;
  /** @experimental */
  readonly signal: AbortSignal;
  /** @experimental */
  readonly state: PluginState;
  /** @experimental */
  get<T>(service: ServiceToken<T>): T;
  /** @experimental */
  optional<T>(service: ServiceToken<T>): T | undefined;
  /** @experimental */
  provide<T>(service: ServiceToken<T>, value: T): void;
  /** @public */
  on<T>(hook: HookDefinition<T>, handler: HookHandler<T>, options?: HookHandlerOptions): Disposer;
  /** @public */
  defer(dispose: Disposer): void;
}

/** @experimental */
export interface PluginDefinition<C = unknown> {
  readonly id: string;
  readonly version: string;
  readonly scope?: PluginScope;
  readonly config?: C;
  readonly configSchema?: JsonSchema;
  readonly provides?: readonly ServiceToken[];
  readonly requires?: readonly ServiceDependency[];
  readonly optional?: readonly ServiceDependency[];
  readonly requiresHooks?: readonly HookDefinition<unknown>[];
  readonly state?: PluginStateDefinition;
  readonly setup: (context: PluginContext<C>) => void | Disposer | Promise<void | Disposer>;
}

/** @experimental */
export type AnyPlugin = PluginDefinition<any>;

/** @experimental */
export interface PluginHostOptions {
  readonly plugins: readonly AnyPlugin[];
  readonly hooks?: readonly HookDefinition<unknown>[];
  readonly services?: readonly ServiceBinding[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly state?: PluginStateSnapshot;
  readonly onStateChange?: (snapshot: PluginStateSnapshot) => Promise<void>;
  readonly onHookError?: (
    error: Error,
    hook: HookDefinition<unknown>,
    pluginId: string,
    context: HookContext,
  ) => void | Promise<void>;
}

/** @experimental */
export interface PluginScopeOptions {
  readonly id: string;
  readonly signal?: AbortSignal;
  readonly state?: PluginStateSnapshot;
  readonly onStateChange?: (snapshot: PluginStateSnapshot) => Promise<void>;
  readonly services?: readonly ServiceBinding[];
}

/** @experimental */
export interface PluginChangeOptions {
  readonly cancelActive?: boolean;
}

/** @experimental */
export interface PluginOperationOptions {
  readonly cancel?: Disposer;
}
