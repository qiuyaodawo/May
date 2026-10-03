# @may/plugin-models

`createModelPlugin({ id?, create, info?, dispose? })` provides `services.model`.
When `info` is present, the factory also provides `services.modelInfo` with the
actual `provider`, `model`, and optional `adapter` and `profile`. Omitting `info`
keeps model metadata unavailable. Consumers use an optional service dependency.
`create(context)` creates the actual Model for one Application; `dispose(model)`
runs when the plugin closes. Register resources acquired during creation with
`context.defer()`, including resources acquired before an error. Passing an existing
Model without a disposer leaves that instance caller-owned.
Both factories accept typed `config`, `configSchema`, dependency declarations,
`requiresHooks`, `state`, and `version` from
[`PluginFactoryMetadata`](../../plugin-services/README.md). Configuration is validated
before creation and its type is preserved in `context.config`.

`createModelWrapperPlugin({ id, create, order?, dispose? })` contributes an ordered
Model wrapper. `create(context)` returns `(model) => Model`; use `context.defer()`
for its resources. Application applies all wrappers whenever it creates a Runtime.
The last applied wrapper receives stream calls first. Each Application obtains a
new wrapper factory context and independent registry.

```ts
const plugin = createModelPlugin({ create: () => providerModel });
```

The Model provider and wrapper registry are separate services; duplicate providers
fail before setup. Runtime integration tests use a real DeepSeek provider, and the
package test verifies validation and cleanup with actual file handles.
