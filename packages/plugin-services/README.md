# @may/plugin-services

Typed service tokens and ordered contribution registries used by `@may/application`
and component plugins. All exported `services` tokens have application scope and
version `1.0.0`; each token has one provider. `applicationServices` reexports these
same tokens and adds access to the actual Application.

`model`, `modelInfo`, `contextFactory`, `permissionPolicy`, `runtimeFactory`, `sessionStore`,
`skills`, `toolExecutor`, `toolScheduler`, and `tracer` describe component instances.
`tools` accepts one existing iterable for compatibility. Multiple contributors use
`toolSources`, `instructionSources`, `modelWrappers`, and `contextWrappers`.

`modelInfo` optionally describes the active Model with `provider`, `model`, and
optional `adapter` and `profile` fields. Consumers declare it as an optional
dependency; a Model with no metadata keeps its name unknown. Model factories
provide metadata together with the instance they describe.

Each registry exposes `add(value, { id, order?, pluginOrder? }): Disposer`. Entries
execute by increasing `order`, then plugin declaration order, then registration
sequence. Duplicate contribution ids fail immediately. Register the returned
disposer with `context.defer()` to remove the contribution when its plugin closes.

```ts
context.defer(context.get(services.toolSources).add(
  () => tools,
  { id: context.pluginId, pluginOrder: context.pluginOrder },
));
```

`ToolSources.snapshot()` returns a `ToolRegistry` with captured definitions and
callbacks, and rejects duplicate tool names. Application captures this catalog for
each Run. `InstructionSources.snapshot()` reads the current sources and joins
nonempty strings with blank lines. Sources must return synchronously.

`ModelWrappers.apply(base)` and `ContextWrappers.apply(base)` wrap their input in
registration order. The last wrapper is outermost, so calls enter it first. Each
Application creates independent registries and applies wrappers when creating its
Runtime; wrappers must return valid component instances. Base services stay available
through their original tokens. Factories acquire resources with `context.defer()`.

`contextOptions` accepts `ContextOptions` or `(effectiveModel) => ContextOptions`.
Application evaluates this source when creating each Runtime, after applying Model
wrappers. Options include `budget`, `compactionStrategy`, `autoCompactionStrategies`,
and `providerNativeAutoCompaction`. This allows summarizers to share the effective
Model and its controls. Only one plugin supplies this configuration.

Component factories accept `PluginFactoryMetadata<C>`: typed `config`, `configSchema`,
`version`, `requires`, `optional`, `requiresHooks`, and `state`. Factory configuration
is validated before setup and retains its type in `create(context)`. Dependencies
declare the services used by the factory or returned component. Required contribution
registries are added automatically; an explicit declaration for the same service
can specify its version range and capabilities. Skills owns its activation state format.

Tests use real file handles and independent in-memory Context instances. Run
`pnpm --filter @may/plugin-services test`.
