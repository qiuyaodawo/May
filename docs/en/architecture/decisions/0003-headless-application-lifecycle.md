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

Products select providers, prompts, UI and coding policy. Reusable behavior
composition is described in [ADR 0004](0004-agent-definitions-and-tool-registries.md).

## Consequences

- Applications share ordering, cancellation, persistence and shutdown logic.
- UIs can target `AgentController`-style headless contracts.
- Core remains usable for ephemeral and fully custom runtimes.
- Products still need a small composition wrapper when they map generic events
  or expose named product strategies.
- `AgentDefinition` composes behavior separately from an application's Session
  storage and identity. See [building an Agent](../../guides/building-an-agent.md).
