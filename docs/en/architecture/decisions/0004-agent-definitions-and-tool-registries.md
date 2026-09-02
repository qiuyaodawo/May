# ADR 0004: Agent definitions and tool registries are reusable composition objects

**English** | [简体中文](../../../zh-CN/architecture/decisions/0004-agent-definitions-and-tool-registries.md)

- **Status:** Accepted
- **Date:** 2026-09-02

## Context

May already separated the Core execution loop from Session and application
lifecycle, but products still repeated two composition patterns:

1. collect tool arrays, check name collisions, and derive lookup/model-facing
   views; and
2. keep a factory that mixed reusable behavior and policy with the store,
   identity, and metadata of one Session.

Arrays remain a useful interchange type, and direct `AgentApplication.open()`
must remain available. They do not, however, make the lifecycle boundary or
duplicate-safe composition rules explicit. A process-global registry would
introduce hidden mutable state and make tests and multiple products interfere
with one another.

## Decision

Core provides `ToolRegistry` as an ordinary instance that implements
`Iterable<Tool>`. It validates tools, retains insertion order, rejects
ambiguous names with `DuplicateToolNameError`, and supports atomic grouped
registration, lookup, snapshots, model-facing definitions, cloning,
iteration, and composition. Registrations preserve original Tool identity while
recording descriptor values/references so later descriptor replacement is
detected. It is not a singleton or service locator.

`May` accepts any `Iterable<Tool>` and snapshots its membership when the
runtime is constructed. A later mutation of the source collection cannot
change an active runtime.

The application package provides `AgentDefinition` and `defineAgent()`.
Definitions capture reusable behavior and policy, including the Model,
instructions, tools, permission policy, Tool executor and scheduler, Context
policy, and application options. They exclude Session-bound storage, identity,
resume, and metadata. Those inputs are passed to:

```ts
definition.open({
  store,
  sessionId,
  resume,
  metadata,
  contextMetadata,
});
```

The definition snapshots iterable membership at creation. Every `open()` call
creates an independent `AgentApplication` and Session lifecycle. The snapshot
does not clone Tool objects or other collaborators: a stateful Model, Context
factory, executor, scheduler, strategy, or policy closure remains caller-owned
and shared when the same definition captures it. Tool descriptor fields must
remain stable; registry checks compare descriptor values/references rather than
deep-freezing the Tool or its JSON Schema.

## Consequences

- Products can assemble feature-owned tool groups without global state or
  hand-written duplicate checks.
- Definitions make the behavior-versus-Session boundary visible and reusable
  for workspace application factories.
- Arrays, sets, generators, and custom registries remain valid tool sources
  through the iterable contract.
- Existing callers may continue to use `AgentApplication.open()` directly.
- Registry changes after construction cannot silently alter a definition or
  active runtime.
- Original Tool identity survives composition, so identity-keyed product
  metadata remains usable without weakening descriptor stability checks.
- Opening multiple applications does not by itself make captured collaborators
  concurrency-safe; products must select or create collaborators with the
  required ownership model.
- An Agent definition is an in-process composition object, not a durable
  manifest, discovery registry, dependency-injection container, or Session
  snapshot.
