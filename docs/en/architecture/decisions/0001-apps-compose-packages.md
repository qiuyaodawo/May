# ADR 0001: Applications compose reusable packages

**English** | [简体中文](../../../zh-CN/architecture/decisions/0001-apps-compose-packages.md)

- **Status:** Accepted
- **Date:** 2026-09-02

## Context

May is both an Agent framework and a monorepo containing executable reference
products. Logic first implemented in MaybeCode included reusable execution,
session and UI behavior, which made it difficult to tell what another Agent
could consume without importing product code.

## Decision

Reusable contracts and implementations live under `packages/`. Executable
products live under `apps/` and select, configure and adapt those packages.
Dependencies point from applications to packages; no reusable package imports
an application.

Product policy—including concrete prompts, commands, palettes, model profiles
and default permission choices—remains in the application unless it becomes a
genuinely reusable parameterized component.

## Consequences

- Another Agent can consume May packages without depending on MaybeCode.
- Package APIs need their own documentation and focused tests.
- MaybeCode acts as a reference composition and integration test.
- Some compatibility adapters stay in MaybeCode even when the underlying
  mechanism moves into a package.
- A package may still contain optional domain components, such as coding-tool
  renderers, but it must not import product implementation code.
