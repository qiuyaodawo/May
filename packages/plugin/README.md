# @may/plugin

Typed services, scoped dependency management, lifecycle cleanup, and Hooks for May plugins. The package can be used independently; `@may/application` connects it to Agent execution and Session history.

## Services and plugins

```ts
import { definePlugin, defineService, PluginHost } from "@may/plugin";

interface Counter {
  read(): number;
  increment(): Promise<void>;
}

const counter = defineService<Counter>({
  id: "example.counter",
  version: "1.0.0",
  scope: "session",
  capabilities: ["increment"],
});

const counterPlugin = definePlugin({
  id: "example.counter",
  version: "1.0.0",
  scope: "session",
  provides: [counter],
  state: {
    version: 1,
    initial: { count: 0 },
    schema: {
      type: "object",
      properties: { count: { type: "integer", minimum: 0 } },
      required: ["count"],
      additionalProperties: false,
    },
  },
  setup(ctx) {
    ctx.provide(counter, {
      read: () => ctx.state.get<{ count: number }>().count,
      increment: () => ctx.state.update((value) => {
        const state = value as { count: number };
        return { count: state.count + 1 };
      }),
    });
  },
});

const host = await PluginHost.create({ plugins: [counterPlugin] });
const application = await host.createScope("application", { id: "application" });
const session = await application.createScope("session", { id: "session" });
await session.get(counter).increment();
console.log(session.get(counter).read());
await host.close();
```

`PluginDefinition` declares `id`, a semantic `version`, optional `config` and `configSchema`, `provides`, `requires`, `optional`, `requiresHooks`, optional persistent `state`, and `setup`. `definePlugin()` retains the configuration type in `ctx.config`. JSON Schema configuration validation uses Ajv in strict mode with synchronous schemas. Hosts capture configuration and declaration arrays at creation; use the composition APIs for later changes.

Services are typed tokens with a stable `id`, interface `version`, `scope`, and capability names. Tokens default to an exact interface version. A dependency can select a compatible version range:

```ts
requires: [{ service: counter, version: "^1.0.0", capabilities: ["increment"] }]
```

`ctx.get(counter)` accesses a declared required or optional dependency. `ctx.optional(counter)` accesses a declared optional dependency and returns `undefined` when absent. Available optional dependencies undergo the same version, capability, and scope validation as required dependencies. `ctx.provide()` only registers services declared in `provides`.
Dependency resolution uses its declared `version` range or its declared service
Token version, including when the accessor uses another Token with the same id and scope.

The host validates the complete graph, including future scopes, before any setup. Invalid configuration, missing dependencies, dependency cycles, duplicate plugin IDs, duplicate providers, incompatible versions, missing capabilities, or unavailable required Hooks fail creation. Choose one provider for each service in each scope through the plugin list. A plugin must register every declared service during setup.

## Scopes and resource ownership

The hierarchy is `host` → `application` → `session` → `run`. `createScope()` creates the immediate child scope; its optional `signal` cancels scope initialization. Plugins default to the `application` scope; services explicitly declare their scope. Each plugin initializes once for each matching scope instance. A service can depend on services in its own scope or an ancestor. A longer lived plugin cannot depend on a shorter lived service instance; use an explicit factory to create operation resources.

`PluginHost.create({ services })` accepts externally owned bindings, including templates for future scopes. `createScope({ services })` can add bindings for that scope and its descendants, subject to complete graph validation. Caller supplied objects remain caller owned. Providing the same object to multiple scopes intentionally shares that object.

Use `ctx.defer(cleanup)` as each resource is acquired. `setup` can also return a cleanup function. Hooks, services, connections, and listeners belong to the plugin that registered them. Cleanup runs in reverse dependency order and in reverse acquisition order within each plugin. Closing a child preserves ancestor resources. Host close stops new operations, cancels active work, closes children, drains active handlers and state writes, and completes every cleanup before reporting aggregated cleanup errors. Repeated close returns the same completion promise.

Setup and handler deadlines provide an `AbortSignal`. Plugin code must honor cancellation and register acquired resources before awaiting further work. The host waits for active JavaScript tasks to settle before releasing their resources; timely cancellation requires cooperative plugin code.

## Hooks

`@may/core` exports `defineHook`, `HookDefinition`, `HookContext`, `HookDispatcher`, `runtimeHooks`, and `RUNTIME_HOOKS`. Application integration supplies its supported Hooks; independent hosts provide them explicitly.

```ts
import { runtimeHooks, RUNTIME_HOOKS } from "@may/core";
import { definePlugin, PluginHost } from "@may/plugin";

const instructions = definePlugin({
  id: "example.instructions",
  version: "1.0.0",
  requiresHooks: [runtimeHooks.contextAfter],
  setup(ctx) {
    ctx.on(runtimeHooks.contextAfter, (snapshot) => ({
      ...snapshot,
      instructions: `${snapshot.instructions ?? ""}\nUse the project formatter.`,
    }), { order: 10, timeoutMs: 5_000 });
  },
});

const host = await PluginHost.create({
  plugins: [instructions],
  hooks: RUNTIME_HOOKS,
});
```

Handlers execute in ascending `order`, then configured plugin order, then registration order. Transformation handlers receive a deeply frozen clone and return a new value; `undefined` preserves the prior value. The host validates input and every replacement using the registered Hook definition. Payloads must support `structuredClone`; service instances and cancellation signals belong in services and `HookContext`.

Observation handlers return no replacement. Failures propagate by default. Observation handlers may opt into `failure: "isolate"` when the host supplies `onHookError`; every isolated failure is reported there. The reporter receives the error, Hook, plugin ID, and cancellable `HookContext`, and has the handler's deadline. Reporter failures propagate. Transformations always propagate failures. `allowAborted` Hooks can deliver cancellation and failure notifications after the operation signal is aborted. Handler cancellation, deadlines, and unload still apply.

## Persistent state

State values contain JSON data. `ctx.state.get()` returns a copy. `set()` and `update()` serialize writes, validate the schema, await `onStateChange`, then expose the new value. A persistence failure preserves the prior state and rejects the operation. `snapshotState()` returns records containing `pluginVersion`, `stateVersion`, and `value` for each plugin.

Pass prior records through `createScope({ state, onStateChange })`. State restoration and migration finish before setup. An unchanged state version also requires the stored plugin version to match `state.compatibleVersions`, which defaults to the exact current plugin version. Incompatible state requires an explicit `state.migrate(previous)` implementation. Migrated state is validated and saved before use. Records for removed plugins remain in the snapshot so historical state can be inspected or migrated later.

`@may/application` persists Session scope snapshots in Session history. The independent host requires an `onStateChange` adapter for durable storage. Host, Application, and Run snapshots can also use caller supplied adapters.

## Configuration and composition changes

`replacePlugins`, `replace`, `remove`, and `updateConfig` serialize composition changes. `validatePlugins()` checks a prospective complete composition without initializing or releasing resources. Validation also occurs inside each change before resource release. Changes affect the selected scope and its descendants, preserve ancestor plugins, and restart that composition in dependency order. Removing a provider also removes plugins with required dependencies on it. Initialization failure leaves the affected composition unavailable; `isReady` reports its current readiness and an explicit valid replacement can restore it.

Use `scope.use(operation, { cancel })` to register an active operation. It holds all ancestor boundaries until completion. New operations are rejected while a change is pending. Changes wait for existing operations by default; `{ cancelActive: true }` calls their registered cancellation handlers and waits for completion before releasing resources. Application integration automatically registers each Run, including its history completion, and rebuilds the runtime after changes.

Composition changes let active operations finish their state writes, then pause
new state writes and wait for every accepted `set()` and `update()` before
disposing resources or restoring state. Writes submitted during this pause
reject. Replacement setup can write the restored state. Closing drains accepted
state saves before resource cleanup.

## Module selections

`loadPluginModules(selections, configFile)` resolves installed ESM packages and local file modules relative to a configuration file. A selection declares `module`, optional named `export`, `config`, and `enabled`. The default export is a `PluginDefinition` object. Configuration validation occurs during host creation, and setup owns resource creation.

## Verification

`pnpm --filter @may/plugin test` builds the package and runs Node tests against real hosts, filesystem handles, Session snapshots, event listeners, and cancellable timers. The tests cover full graph validation, compatible service versions, resource ownership, scoped state, migration, immutable Hooks, deadlines, failure reporting, composition changes, and ESM module loading. These tests verify host behavior without proving live model provider behavior.
