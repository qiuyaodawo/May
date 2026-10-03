# @may/plugin-runtime

`createRuntimePlugin(factory?, id?)` supplies `services.runtimeFactory`. Its default
factory creates the real Core `May` runtime. Application owns each returned Runtime,
including saving, migration and closing before plugin resources are released.
It also accepts `{ id?, factory?, create?, dispose?, ...metadata }`; `create(context)`
returns the Runtime factory and may use declared services and persistent state.
Choose one of `factory` or `create` when supplying a custom source.

`createContextPlugin({ id?, create?, options?, dispose? })` supplies
`services.contextFactory`, defaulting to `InMemoryContextFactory`. `options` supplies
the single `contextOptions` service as an object or an effective-Model callback.
`create(context)` runs independently for each Application. `dispose(factory)` and
`context.defer()` manage acquired resources.

`createContextWrapperPlugin({ id, create, order?, dispose? })` registers
`(factory) => ContextFactory` returned by `create(context)`. Wrappers apply in order;
the last applied wrapper receives `create()` calls first.

`createToolsPlugin({ id, create, order?, dispose? })` registers a tool source returned
by `create(context)`: `() => Iterable<Tool>`. The contribution is automatically
removed during plugin cleanup. Actual resource handles belong to that plugin and
should be registered with `context.defer()`. Multiple sources compose into a
duplicate-checked catalog captured per Run.
Factories accept typed `config`, `configSchema`, dependencies, `requiresHooks`,
`state`, and `version` described in
[`PluginFactoryMetadata`](../../plugin-services/README.md). Configuration is
validated before setup, and required registries are declared automatically.

Tests use actual file handles, the Core Runtime factory and independent Context
instances: `pnpm --filter @may/plugin-runtime test`.
