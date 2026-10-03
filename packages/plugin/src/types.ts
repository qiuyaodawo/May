import type { HookContext, HookDefinition, JsonSchema } from "@may/core";

export type PluginScope = "host" | "application" | "session" | "run";
export type Disposer = () => void | Promise<void>;

export interface ServiceToken<T = unknown> {
  readonly id: string;
  readonly version: string;
  readonly scope: PluginScope;
  readonly capabilities: readonly string[];
  readonly valueType?: T;
}

export interface ServiceDependency {
  readonly service: ServiceToken;
  readonly version?: string;
  readonly capabilities?: readonly string[];
}

export interface ServiceBinding<T = unknown> {
  readonly service: ServiceToken<T>;
  readonly value: T;
}

export interface PluginStateRecord {
  readonly pluginVersion: string;
  readonly stateVersion: number;
  readonly value: unknown;
}

export type PluginStateSnapshot = Readonly<Record<string, PluginStateRecord>>;

export interface PluginStateDefinition {
  readonly version: number;
  readonly schema?: JsonSchema;
  readonly initial: unknown;
  readonly compatibleVersions?: string;
  readonly migrate?: (previous: PluginStateRecord) => unknown | Promise<unknown>;
}

export interface PluginState {
  get<T = unknown>(): T;
  set(value: unknown): Promise<void>;
  update(update: (value: unknown) => unknown | Promise<unknown>): Promise<void>;
}

export interface HookHandlerOptions {
  readonly order?: number;
  readonly timeoutMs?: number;
  readonly failure?: "propagate" | "isolate";
}

export type HookHandler<T> = (value: Readonly<T>, context: HookContext) => T | void | Promise<T | void>;

export interface PluginContext<C = unknown> {
  readonly pluginId: string;
  readonly pluginOrder: number;
  readonly scope: PluginScope;
  readonly scopeId: string;
  readonly config: Readonly<C>;
  readonly signal: AbortSignal;
  readonly state: PluginState;
  get<T>(service: ServiceToken<T>): T;
  optional<T>(service: ServiceToken<T>): T | undefined;
  provide<T>(service: ServiceToken<T>, value: T): void;
  on<T>(hook: HookDefinition<T>, handler: HookHandler<T>, options?: HookHandlerOptions): Disposer;
  defer(dispose: Disposer): void;
}

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

export type AnyPlugin = PluginDefinition<any>;

export interface PluginHostOptions {
  readonly plugins: readonly AnyPlugin[];
  readonly hooks?: readonly HookDefinition<unknown>[];
  readonly services?: readonly ServiceBinding[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly state?: PluginStateSnapshot;
  readonly onStateChange?: (snapshot: PluginStateSnapshot) => Promise<void>;
  readonly onHookError?: (error: Error, hook: HookDefinition<unknown>, pluginId: string, context: HookContext) => void | Promise<void>;
}

export interface PluginScopeOptions {
  readonly id: string;
  readonly signal?: AbortSignal;
  readonly state?: PluginStateSnapshot;
  readonly onStateChange?: (snapshot: PluginStateSnapshot) => Promise<void>;
  readonly services?: readonly ServiceBinding[];
}

export interface PluginChangeOptions {
  readonly cancelActive?: boolean;
}

export interface PluginOperationOptions {
  readonly cancel?: Disposer;
}
