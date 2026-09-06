# MCP host adaptation roadmap

**English** | [简体中文](../../zh-CN/architecture/mcp-host-roadmap.md)

The requested end state includes all remaining phases of the MCP design, not
just HTTP tools. This checklist tracks implementation and evidence; unchecked
items are not supported merely because the SDK has a corresponding method.
Core must remain protocol-independent. Existing ADR 0006's tool-execution and
permission boundary remains in force.

- [x] **Transport baseline:** stdio + Streamable HTTP, modern discovery and
  legacy negotiation, cancellation/cleanup, safe diagnostics, MaybeCode config.
  Evidence: `packages/mcp/test/mcp.test.mjs` and MaybeCode configuration tests.
- [x] **Native OAuth + credential storage:** PKCE/state/issuer validation,
  public pre-registration/CIMD/DCR, scope consent, serialized refresh and issuer
  partitioning, logout/revocation, encrypted OS-keyring-backed vault, CLI before
  model startup. Evidence: `packages/mcp/test/oauth.test.mjs`, MaybeCode command
  test, and opt-in Windows native keyring smoke. See [authentication](../guides/mcp-auth.md).
- [x] **Capabilities and dynamic catalogs:** tools, resources/templates, prompts,
  completion, caching/subscriptions, bounded content/attachment adaptation;
  immutable per-Run tool snapshots, definition-based permission invalidation,
  endpoint refresh/reconnect without unsafe operation replay.
- [ ] **Host interactions:** Elicitation form/URL, MRTR, scoped
  workspace/session/run/request routing, cancellation/expiry/budgets, headless
  controller + UI, explicit legacy Roots/Sampling compatibility, no deadlocks
  or unsolicited context/model access.
- [ ] **Long tasks and extensions:** task handles, get/update/cancel, durable
  ownership and restart recovery, local-wait vs remote-cancel semantics;
  optional isolated MCP Apps UI with explicit unsupported-terminal behavior.
- [ ] **Independent MCP server:** opt-in May tool/resource/prompt export,
  authenticated principals and workspace isolation, normal permission/execution
  pipeline, no blanket export of host tools or Session history.
- [ ] **Completion audit:** verify each phase with focused behavior tests and
  product integration, update every maintained language, review safety
  boundaries and actual supported versions/extensions, commit completed work.

OAuth changes do not imply completed catalogs, host interactions, or extensions.
Do not mark the overall migration complete until all rows have direct evidence.

Capabilities evidence: `catalog.test.mjs`, `capabilities.test.mjs`, OAuth cache
isolation tests, Core registry/permission tests and MaybeCode configured/MCP
command tests. Tools/resources/templates/prompts/completion, bounded attachments,
cache invalidation and modern/legacy subscriptions are implemented. Interaction
broker/MRTR, tasks/Apps, server export and final audit remain open.
