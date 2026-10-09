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
remains available. Composition objects make ownership and duplicate-name
validation explicit for multiple products in one process.

## Decision

Core provides `ToolRegistry` as an ordinary instance that implements
`Iterable<Tool>`. It validates tools, retains insertion order, rejects
ambiguous names with `DuplicateToolNameError`, and supports atomic grouped
registration, lookup, snapshots, model-facing definitions, cloning,
iteration, and composition. Registrations preserve original Tool identity while
recording descriptor values/references so later descriptor replacement is
detected. Each caller owns its registry instance.

`May` accepts any `Iterable<Tool>` and snapshots its membership when the
runtime is constructed. A later mutation of the source collection cannot
change an active runtime.

Per-Run `snapshot()` creates frozen Tool facades and schema copies for execution.
Dynamic `toolSource` collections are captured at Run start. See the
[compatibility reference](../../reference/compatibility.md#per-run-dynamic-tool-catalogs)
for callback identity and update behavior.

The application package provides `AgentDefinition` and `defineAgent()`.
Definitions capture reusable behavior and policy, including the Model,
instructions, tools, permission policy, Tool executor and scheduler, Context
policy, and application options. Session-bound storage, identity, resume and
metadata are supplied to each `open()` call. For a complete application, follow
the [Agent building guide](../../guides/building-an-agent.md).

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
- Ordinary registry composition preserves Tool identity; Run execution uses
  frozen facades. Execution metadata belongs in Tool fields.
- Opening multiple applications does not by itself make captured collaborators
  concurrency-safe; products must select or create collaborators with the
  required ownership model.
- An Agent definition is an in-process composition object, not a durable
  manifest, discovery registry, dependency-injection container, or Session
  snapshot.
