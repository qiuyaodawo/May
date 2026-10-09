# Write and load plugins

**English** | [简体中文](../../zh-CN/guides/plugins.md)

Use this guide to add a service or lifecycle handler to an existing May
application. You need an application composition, the service or Hook you want
to extend, and installed `@may/plugin` and `@may/application` packages.

1. Declare services and plugin setup using the [example](#declare-a-plugin).
2. Add the definitions to your application's `plugins`, or
   [load a module through product configuration](#load-plugins-in-products).
3. Register cleanup when acquiring resources and select the scope that owns them.
4. Verify initialization, Hook execution, state restoration and shutdown.

`@may/plugin` manages configuration and resources. Core defines typed Hooks and
`AgentRuntime`; Application integrates them with permissions, Context and durable
Session storage. The [architecture explanation](../architecture/plugins.md)
describes their lifecycle and dependency rules.

## Plugin definition and composition

A plugin is a functional unit managed by a host. It declares its identity,
provided capabilities, dependencies and setup procedure. The host validates the
composition, initializes plugins in dependency order and releases resources at
shutdown.

One plugin can contain several classes or functions and provide several services.
For example, a runtime plugin can jointly manage an Agent loop and its Context.

`PluginDefinition` contains the following fields:

| Part | Fields | Requirement and purpose |
| --- | --- | --- |
| Identity | `id`, `version` | Required; identify the plugin and its Semantic Version |
| Initialization | `setup(ctx)` | Required; create instances, provide services, register Hooks and cleanup |
| Lifecycle scope | `scope` | Optional; `host`, `application`, `session` or `run`, defaulting to `application` |
| Configuration | `config`, `configSchema` | Optional; supply configuration and JSON Schema validation rules |
| Provided capabilities | `provides` | Optional; declare ServiceTokens whose instances are registered with `ctx.provide()` |
| Service dependencies | `requires`, `optional` | Optional; declare required and optional services, including version ranges and capabilities |
| Hook requirements | `requiresHooks` | Optional; declare Hook entry points the host must support |
| State | `state` | Optional; declares required `version` and `initial`, and optional `schema`, `compatibleVersions` and `migrate` |

Plugins select the optional fields their functionality needs. Register resource
cleanup through `ctx.defer()`; `setup()` can also return a synchronous or asynchronous
cleanup function.

### PluginContext and ctx

`PluginHost` creates a `PluginContext` for each plugin instance and passes it
to `setup(ctx)` during initialization.

| Interface | Purpose |
| --- | --- |
| `pluginId`, `pluginOrder`, `scope`, `scopeId` | Identify the plugin, its declaration order and its owning scope instance |
| `config` | Access a readonly configuration copy after configuration validation |
| `get()`, `optional()` | Obtain declared required or optional dependency services |
| `provide()` | Register a declared service instance |
| `on()` | Register a Hook handler with host-managed ordering, deadlines, cancellation and cleanup |
| `state.get()`, `state.set()`, `state.update()` | Read a state copy, validate updates and await the configured save callback |
| `defer()` | Register resource cleanup |
| `signal` | Receive initialization cancellation, scope shutdown and plugin-unload notifications |

PluginContext manages plugin configuration and lifecycle. The Agent's `Context`
interface stores and supplies model-visible messages. Each serves that responsibility.

## Declare a plugin

In an ESM TypeScript module, declare the following two plugins. The example adds
`Project: ` to string input through `inputBeforeSubmit`; it keeps non-string input
unchanged. The application supplies its own Model and storage separately.

```ts
import { definePlugin, defineService } from "@may/plugin";
import { applicationHooks } from "@may/application";

const labels = defineService<{ prefix: string }>({
  id: "example.labels", version: "1.0.0", scope: "application",
});

const labelsPlugin = definePlugin({
  id: "example.labels", version: "1.0.0", provides: [labels],
  config: { prefix: "Project: " },
  configSchema: {
    type: "object", required: ["prefix"], additionalProperties: false,
    properties: { prefix: { type: "string" } },
  },
  setup(ctx) { ctx.provide(labels, ctx.config); },
});

const inputPlugin = definePlugin({
  id: "example.input", version: "1.0.0",
  requires: [{ service: labels, version: "^1.0.0" }],
  requiresHooks: [applicationHooks.inputBeforeSubmit],
  setup(ctx) {
    const label = ctx.get(labels);
    ctx.on(applicationHooks.inputBeforeSubmit, (value) => ({
      ...value,
      input: typeof value.input === "string"
        ? label.prefix + value.input : value.input,
    }));
  },
});
```

Pass `[inputPlugin, labelsPlugin]` as `plugins` to `defineAgent()` or
`AgentApplication.open()`. Dependency order determines setup order. The plugin
configuration order determines equal-priority Hook order. A definition may provide
several services and register several Hooks.

Configuration schemas use Ajv validation. Service tokens contain `id`, exact Semantic Version, scope,
and capabilities. Dependencies can supply a version range and required capabilities.
An absent optional service returns `undefined` through `ctx.optional()`;
an existing optional service must satisfy its version and capability requirements.
`ctx.get()` and `ctx.optional()` require a declared dependency.

Duplicate plugin ids, duplicate service providers, missing dependencies,
incompatible versions, unmet capabilities, cycles, unknown required Hooks and
dependencies on shorter-lived scopes fail validation before plugin setup.

## Own resources within scopes

Scopes form the sequence `host` → `application` → `session` → `run`. A child
can use services from its own scope and ancestors. Each child gets independent
instances of its own plugins. Setup follows dependencies, and cleanup follows
their reverse order.

`ctx.defer()` registers asynchronous or synchronous cleanup. `setup` can return
one additional disposer. `ctx.on()` automatically registers unsubscription.
Register cleanup as each resource is acquired so setup failure can release it.
Close waits for active work, releases children before parents, continues after
individual cleanup failures, and reports an `AggregateError`. Repeated `close()`
calls share the same completion.

For a custom host, the following fragment assumes your plugin definitions,
`myHook`, service bindings, `operation` and `cancelOperation` already exist.
Keep the host alive for the operation and close it even if the operation fails:

```ts
import { PluginHost } from "@may/plugin";

const host = await PluginHost.create({ plugins, hooks: [myHook], services });
try {
  const application = await host.createScope("application", { id: "app" });
  const session = await application.createScope("session", { id: "conversation" });
  await session.use(() => operation(), { cancel: () => cancelOperation() });
} finally {
  await host.close();
}
```

`use()` tracks work through all ancestors. Resources supplied through `services`
remain owned by their caller; plugin-acquired resources use plugin disposers.
An aborted signal asks work to stop; handlers and disposers must cooperate with
cancellation so the host can finish waiting for them.

## Transform and observe lifecycle data

`defineHook()` creates a named Hook with `kind: "transform"` or `"observe"`
and a validator. `runtimeHooks` and `applicationHooks` expose these entry points:

| Area | Hook exports |
| --- | --- |
| Application | `beforeCreate`, `created`, `beforeClose`, `closed` |
| Input | `inputReceived`, `inputBeforeSubmit`, `inputSubmitted` |
| Run | `runBefore`, `runStarted`, `runBeforeEnd`, `runEnded`, `runFailed` |
| Step | `stepBefore`, `stepCompleted` |
| Context | `contextBefore`, `contextAfter`, `compactionBefore`, `compactionCompleted`, `compactionFailed` |
| Model | `modelBefore`, `modelEvent`, `modelAfter`, `modelFailed` |
| Tool | `toolBefore`, `toolProgress`, `toolResult`, `toolAfter`, `toolFailed` |
| Approval and recovery | `approvalRequested`, `approvalResolved`, `recoveryBefore`, `recoveryResolved` |

`ctx.on(hook, handler, { order, timeoutMs, failure })` registers a handler.
Handlers run by ascending `order`, then plugin configuration order, then
registration order. Each receives a cloned immutable value and a context with
an `AbortSignal` and available Session/Run/Step identity. Transform handlers
return a validated replacement or `undefined` to keep the value. Observers
return no replacement. The default timeout is 30000 milliseconds, configurable
through `PluginHostOptions.timeoutMs` or `AgentApplicationOptions.pluginHookTimeoutMs`.

Errors propagate by default. Explicit observation isolation requires
`PluginHostOptions.onHookError`; the host awaits that reporter. Transform errors
always propagate. Applications supply the reporter through `onPluginHookError`.
Terminal observation Hooks declare `allowAborted` so cancellation
can still be observed. Agents using `May` directly can inject a `HookDispatcher`
without opening a plugin host.

`toolBefore` transforms parsed JSON before tool validation and authorization.
Tool name and call identity stay fixed; the final validated arguments are immutable
during permission checks and execution. `toolResult` changes model-visible
content while durable tool completion retains the raw output. `runBeforeEnd`
can request continuation with `continueMessages`; Session acknowledges generated
input before the next Step. Run cancellation, budgets and host yield retain
their control over continuation.

The optional `Tool.parse()` validates or coerces the transformed arguments.
`inputSchema` declares the tool's input to the model. Tools that require execution
validation provide `parse()`.

`freezeToolInput()` protects parsed objects and arrays recursively and preserves
custom instance prototypes and methods. Tools and policies treat input as
read-only. Mutable built-in containers such as Date, Map and Set require ordinary
data object or array representations. Custom classes must protect internal state
that their own fields do not expose.

## Runtime and application services

`@may/plugin-services` defines the shared typed tokens. `applicationServices`
reexports them and adds `application`, whose `get()` returns the active
AgentApplication after creation. Tokens cover `model`, `modelInfo`, `contextFactory`,
`contextOptions`, `sessionStore`, `permissionPolicy`, `toolExecutor`,
`toolScheduler`, `tracer`, `tools`, `skills`, `runtimeFactory`, `toolSources`,
`instructionSources`, `modelWrappers` and `contextWrappers`.
Direct options are composed through the corresponding plugin factories.
Service providers supplied through plugins must have a unique provider. A plugin
can jointly provide a runtime factory and its Context factory.
The Session store supplied through `open({ store })` is a caller-owned entry
service used during restoration and remains the same for that Session.

`createModelPlugin({ create, info })` may also provide `modelInfo`, describing the
actual instance's provider, model, adapter and profile. A plugin that provides
only `model` keeps unknown metadata undefined. MaybeCode can open with empty
`providers` and `models` when an application plugin supplies the Model. Its Context
budget follows the effective Model's `limits`, with explicit `contextBudget`
taking precedence. Profile selection, reasoning-effort changes and the configured
MCP sampling factory use configuration-backed model factories. A custom Model
plugin supplies its own related capabilities when needed.

The reserved `may.model.provider`, `may.model.name`, `may.model.adapter` and
`may.model.profile` trace fields come from the active `modelInfo` service.
Provide them through `createModelPlugin({ create, info })`; a Model-only plugin
leaves those fields undefined. Other caller-defined trace attributes are retained.

Tool and instruction contributions register with `add(value, { id, order,
pluginOrder })`, which returns a cleanup function. Contributions execute in order
of `order`, plugin declaration order and registration order. Tools are snapshotted
for each Run and duplicate names fail immediately. Model and Context wrappers
apply separately when each runtime is created. `contextOptions` may be a function
of the fully wrapped Model. Plugins observe the created Application through
`applicationHooks.created`; replacement invokes creation handlers to attach
replacement services to the existing Application.

## Reusable plugin packages

The reusable plugin package list is explicit:

| Package | Factories and responsibility |
| --- | --- |
| `@may/plugin-runtime` | `createRuntimePlugin`, `createContextPlugin`, `createToolsPlugin`, `createContextWrapperPlugin`; runtime, Context and tool composition |
| `@may/plugin-models` | `createModelPlugin`, `createModelWrapperPlugin`; Model instances and wrappers |
| `@may/plugin-permissions` | `createPermissionPlugin`; PermissionPolicy |
| `@may/plugin-skills` | `createSkillsPlugin`; discovery, activation, instructions, tools and saved state |
| `@may/plugin-goals` | `createGoalsPlugin`; persistent goals, budgets and continuation |
| `@may/plugin-history-memory` | `createHistoryMemoryPlugin`; historical context notes, retrieval and compaction |
| `@may/plugin-delegation` | `createDelegationPlugin`, `createWorkspaceFilesPlugin`; child Agents, shared budgets and workspace file access |
| `@may/plugin-mcp` | `createMcpPlugin`, `createMcpHostPlugin`, `createSharedMcpPlugin`; connections, catalogs, authentication, interactions and task journals |
| `@may/plugin-observability` | application, host and shared observability factories; tracing and exporter shutdown |
| `@may/plugin-delivery` | `createDeliveryPlugin`; durable channel records, registered receivers and single-attempt delivery outcomes |
| `@may/plugin-channel-telegram` | `createTelegramChannelPlugin`; Telegram receiver, routing and attachments |
| `@may/plugin-channel-feishu` | `createFeishuChannelPlugin`; Feishu receiver, routing and attachments |
| `@may/plugin-agent-adapters` | `createAgentAdaptersPlugin`, `createMayAgentAdapter`, `loadAgentAdapter`, RPC adapters; conversation and adapter resource management |
| `@may/plugin-coordination` | `createCoordinationPlugin`; task graph creation, restoration and release |
| `@may/plugin-web-api` | `createWebApiPlugin`; HTTP listener, active requests and connections |

Implementations live in `packages/plugins/<name>/`. Shared tokens and ordered
registries live in `packages/plugin-services/`; the plugin host remains in
`packages/plugin/`. Product composition lives in
`apps/maybecode/src/plugins/` and `apps/maybeclaw/src/plugins/`.
Existing package classes and interfaces remain available for direct integration.
Applications retain compatible exports for extracted functionality.

`@may/plugin-agent-adapters` supports validated version 1 `TelemetryCorrelation`
through `AgentAdapterContext.telemetry`. RPC transports negotiate
`telemetryVersion: 1` before sending the separate envelope and validate it before
execution. Business deduplication excludes telemetry identities. See
[model and execution diagnostics](model-telemetry-integration.md) for correlation
and configuration responsibilities.

MaybeCode composes its Model, PermissionPolicy, Context, Skills, goals,
history-memory and delegation through plugins. MCP commands, catalogs and events
use the active Application's `mcpService`. Application-owned pools start and close
with each Session; configured shared pools and observability resources belong to
the workspace host. A selected MCP provider suppresses unused configured MCP
resources. Delegated Agents receive the active `mcpService` tool catalog through
the delegation plugin's optional dependency. MaybeClaw's host composes channel
ingress, delivery and protocol plugins, while AgentGateway owns adapter
and coordination plugins. Idle release removes an adapter from the registry;
the next access creates an instance from current configuration. The Web host
closes the listener and active connections before disposing product routes and
authentication. Closing begins cancellation of Gateway work before waiting for
HTTP requests and resource cleanup. `GatewayHost.start({ startPaused: true })` initializes these
services; `startLoops()` starts receiving, background processing, and automatic
delivery. While paused, `tick()` processes stored inputs and queues replies;
`deliver()` explicitly sends pending messages.

`pnpm test:package:plugin` packs the host, shared services, all 15 reusable plugin
packages and their complete May runtime dependency chains. It installs the
tarballs in a consumer directory outside the repository and executes their exported APIs.
Applications remain private. Public package additions require the same check.

## Runtime factory

`defaultRuntimePlugin` supplies the default May runtime when no plugin provides
`runtimeFactory`. A `RuntimeFactory` receives `MayOptions` and returns an
`AgentRuntime`. The runtime supports `run`, `continue`, and `appendMessages`,
and can declare a descriptor, supported Hooks and state save/restore methods.
Runtime Hook requirements are checked against the constructed runtime's
`supportedHooks` before it can execute.

`Session` persists runtime identity and version and validates them on resume.
Runtime state uses explicit `stateVersion`; version changes require the runtime's
`migrateState(savedDescriptor, state)` method. Runtime-owned resources use its
optional `close()` method. `Session.getRuntimeInfo()`, `saveRuntimeState()`,
`suspendRuntime()`, `replaceRuntime()` and `closeRuntime()` expose the corresponding
host operations. Suspension saves state and closes the old runtime before its
plugin services are released. Replacement restores the saved state and resumes
execution.
`AgentApplication.getService(token)` resolves an active scoped service. Model-only
callers can omit `permissionPolicy`; tool execution requires an explicit policy.

`compactionBefore` runs before each configured automatic strategy and can select
another configured strategy. A failing control Hook stops automatic compaction.

## Durable state and composition changes

A plugin's `state` declares `version`, `initial`, optional JSON Schema,
`compatibleVersions`, and `migrate`. `ctx.state.get()` returns a copy.
`set()` and `update()` validate and await the scope's `onStateChange` writer.
`snapshotState()` returns versioned records. Restoring incompatible plugin or
state versions requires explicit migration. Unknown saved plugin records remain
available in history.

`AgentApplication` saves application and session scope state under `may.plugins`.
Run scope state is temporary. `updatePlugins(plugins, { cancelActive })` serializes
composition changes, waits for the current operation, validates the new graph,
releases affected instances and constructs the replacement runtime from durable
messages and state. `cancelActive: true` requests cancellation before waiting.
History queries remain available after a replacement initialization failure.

Composition changes let active operations finish state writes, then pause new
state calls and drain accepted `set()` and `update()` calls before resource
cleanup and state restoration. Calls submitted during that pause reject.
Replacement setup can update the restored state.

Direct hosts expose `replacePlugins()`, `replace()`, `remove()` and
`updateConfig()`. `validatePlugins()` verifies a prospective composition without
releasing resources. Removing a provider also removes required dependants; optional
consumers are reconstructed without it. A child scope cannot modify its ancestors.

## Load plugins in products

Add the following `plugins` array to the relevant application section of your May
configuration. The module must exist beside the configuration at the shown relative
path and export a `PluginDefinition`. MaybeCode reads `apps.maybecode.plugins`.
MaybeClaw's May adapter reads
`apps.maybeclaw.agents[].plugins`:

```json
{
  "plugins": [
    { "module": "./plugins/project.mjs", "export": "default", "config": {} }
  ]
}
```

The module exports a `PluginDefinition` object. Relative files and installed
package specifiers resolve from the configuration file. `export` defaults to
`default`; `enabled: false` skips resolution and import. Only modules resolving
to local files are accepted. `loadPluginModules()` and `parsePluginSelections()`
provide the same loader for custom applications. Loaded modules execute with
the host process's permissions; register resources inside `setup` and `ctx.defer()`.

## Verification

With your real plugin, confirm setup runs in dependency order, the input Hook
changes the intended input, resources close in reverse dependency order, and
persisted state survives reopening. Check a missing dependency and incompatible
state version fail before execution.

From the repository root, run `pnpm --filter @may/plugin test`, `pnpm docs:check`, and
`pnpm test:package:plugin` for the host, documentation and independently installed
package checks. Real provider tests are separate from the offline suite.
