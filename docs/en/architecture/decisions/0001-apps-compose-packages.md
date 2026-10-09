# ADR 0001: Applications compose reusable packages

**English** | [简体中文](../../../zh-CN/architecture/decisions/0001-apps-compose-packages.md)

- **Status:** Accepted
- **Date:** 2026-09-02

## Context

May contains reusable Agent packages and executable products. Execution, Session
and UI components need public package boundaries so applications can reuse them
independently of product policy.

## Decision

Reusable contracts and implementations live under `packages/`. Executable
products live under `apps/` and select, configure and adapt those packages.
Dependencies point from applications to packages; no reusable package imports
an application.

Product policy—including concrete prompts, commands, palettes, model profiles
and default permission choices—remains in the application unless it becomes a
reusable parameterized component.

## Consequences

- Another Agent can consume May packages without depending on MaybeCode.
- Package APIs need their own documentation and focused tests.
- MaybeCode acts as a reference composition and integration test.
- Products own compatibility adapters that map their behavior to package APIs.
- A package may still contain optional domain components, such as coding-tool
  renderers, but it must not import product implementation code.

See the [package catalog](../../reference/packages.md) for the current package roles.
