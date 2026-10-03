# Plugin system specification

**English** | [简体中文](../../zh-CN/architecture/plugin-spec.md)

May exposes reusable capabilities through plugins, typed services and lifecycle
hooks. Applications select their own composition. Existing direct package APIs
remain available.

## Definitions

A Plugin is a configured lifecycle unit. A Service is a named, typed capability
with a version, scope and implementation. A Hook is a declared execution point
with a validator and explicit transformation or observation semantics. A
PluginHost validates the composition and owns startup, changes and cleanup.

## Composition and services

Plugins declare stable ids, semantic versions, configuration schemas, provided
services, required and optional services, required hooks and setup. Each service
has a stable id, version, capabilities and host, application, session or run scope.
Required services and hooks must exist before any setup executes. Duplicate
providers, incompatible versions, unmet capabilities, cycles and dependencies
on shorter-lived services fail validation. Optional dependencies are absent
explicitly. No implicit provider selection is performed.

Services become available only after their provider finishes initialization.
Consumers use declared dependencies. A plugin may own several services and hooks,
including a runtime and its associated Context. External shared instances retain
their caller's ownership unless an explicit disposer transfers it.

## Lifecycle and scopes

Host, application, session and run form nested scopes. Setup follows dependency
order; cleanup follows reverse dependency order. Every listener, timer, connection
and background operation has an owner. Setup failure stops further setup and
cleans already initialized plugins. Cleanup completes for remaining resources
and aggregates errors. Closing rejects new work and is idempotent.

Configuration, add, remove and replacement are serialized. The prospective graph
is validated before active providers are removed. Work using affected resources
must finish or be cancelled and drained before a change. New operations cannot
race a pending change. Failed replacement leaves the affected scope unavailable;
durable history remains readable. Session state has explicit schema versions and
migrations and must be verified before resumed execution.

## Hooks

The supported catalog covers application creation/closure, input submission,
Run startup/settlement, Step boundaries, Context views and compaction, model
requests/streams/responses/failures, tool arguments/execution/progress/results,
approval observations and recovery. A runtime advertises the hooks it supports.
Unsupported required hooks fail composition validation.

Transformations run in explicit order, then plugin configuration order, then
registration order. Inputs and replacements are cloned and validated. Observers
cannot mutate execution data. Every awaited handler has a timeout and cancellation
signal. Control errors fail the operation; explicitly isolated observation errors
must be reported. Handler cleanup removes its registration.

Tool argument transformations precede final validation and authorization. No
mutation occurs between authorization and execution. Hooks cannot broaden host
permissions. Raw tool outcomes remain available separately from transformed
model-facing content. Durable messages, state changes, compaction and continuation
requests use acknowledged Session writes. Cancellation, Run budgets and host yield
take precedence over continuation requests. Resume never replays historical tools.

## Built-in plugin composition

Shared service tokens and ordered contribution registries belong to
`@may/plugin-services`. Runtime, Context, Model, permissions, Skills, goals,
history-memory, delegation, MCP, observability, delivery, channels, Agent adapters,
coordination and Web/API are supplied by reusable factories under
`packages/plugins/`. Product configuration and combinations belong to the
applications' `src/plugins/` directories. Packages do not import applications.

Tool and instruction contributions have stable identities and cleanup functions.
Model and Context wrappers apply to each new runtime in explicit order, plugin
declaration order and registration order. Context configuration may depend on the
wrapped Model. Factories declare their service and Hook dependencies. Product
defaults are selected when the configured combination has no provider for that
service. Replacements receive creation notifications for the current Application.

Workspace-wide MCP and tracing resources are shared across Session changes and
closed by their owning host. Adapter registries create instances on demand,
validate capabilities and remove released instances. Coordination registries
release completed runtimes. Channel plugins own their receive loops; delivery
records preserve acknowledged, pending and unknown outcomes. HTTP listener
shutdown closes connections and waits for requests before disposing product
routes. Cleanup continues after errors and reports all cleanup failures.

## Integration and verification

AgentDefinition selects plugins; AgentApplication opens their scopes and integrates
Session state. The default May loop is offered by a runtime plugin through a
replaceable runtime factory. MaybeCode and MaybeClaw accept product-specific plugin
selection without changing direct callers.

Acceptance requires real service/resource tests for startup validation, scope
isolation, reverse cleanup, setup failure, timeout, cancellation, changes, migration,
permission ordering, durable projections and restoration. Existing offline suites,
build and bilingual documentation checks must pass. Published package dependency
chains must install in an external packed-package consumer. Live provider validation
must be reported separately from offline verification.
