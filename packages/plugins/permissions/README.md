# @may/plugin-permissions

`createPermissionPlugin({ id?, create, dispose? })` provides
`services.permissionPolicy`. `create(context)` returns the actual permission policy
for one Application. Optional `dispose(policy)` and `context.defer()` own cleanup.
An existing policy with no disposer remains caller-owned.
Typed `config`, `configSchema`, dependencies, `requiresHooks`, `state`, and `version`
are supported through [`PluginFactoryMetadata`](../../plugin-services/README.md).
Configuration is validated before resources are acquired; `create(context)` can
read declared services and persistent state.

Application keeps approval requests, durable permission events and its
`PermissionToolExecutor`; policy evaluation resolves the currently enabled service.
One plugin supplies the policy. Duplicate providers fail before setup.

Tests evaluate policies against real file resources and verify independent scope
cleanup: `pnpm --filter @may/plugin-permissions test`.
