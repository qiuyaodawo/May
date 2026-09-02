# ADR 0003: Shared lifecycle belongs in `@may/application`

**English** | [简体中文](../../../zh-CN/architecture/decisions/0003-headless-application-lifecycle.md)

- **Status:** Accepted
- **Date:** 2026-09-02

## Context

Core intentionally owns only one model/tool execution loop. Complete Agent
products additionally need durable Session creation and resume, approval
relays, context-compaction persistence, cancellation, Catalog summaries and
serialized Session replacement. Keeping this orchestration in MaybeCode made
another application repeat the same lifecycle and error-prone shutdown order.

## Decision

Provide a headless application layer above Core:

- `AgentApplication` owns one active Session and its runtime resources;
- `AgentWorkspace` owns active-session selection, Catalog projection and
  serialized state transitions;
- products inject models, tools, instructions, policies, Context factories and
  stores;
- product-specific state can use `runStateTransition`, while changes that
  rebuild the runtime use `transitionApplication`.

This layer does not define a universal declarative Agent definition, provider
registry, default prompt, UI or coding policy.

## Consequences

- Applications share ordering, cancellation, persistence and shutdown logic.
- UIs can target `AgentController`-style headless contracts.
- Core remains usable for ephemeral and fully custom runtimes.
- Products still need a small composition wrapper when they map generic events
  or expose named product strategies.
- Declarative Agent definitions, tool registries and distributed execution
  remain possible future layers rather than responsibilities silently added to
  Core.
