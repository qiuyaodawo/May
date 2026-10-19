# @sortedyuan/permissions

## 0.2.1

### Patch Changes

- 92fc3b9: Preserve full file identifier precision when checking rule file and writer lock ownership, including large Windows file identifiers. Reject access after lock replacement and preserve the replacement lock on close.

## 0.2.0

### Minor Changes

- 5d3b04a: Add opt-in persistent allow and deny rules with trusted scope, tool-definition
  binding, creator identity, expiry and revocation. Provide a versioned file store
  with atomic replacement and a single writer lock through
  `@sortedyuan/permissions/file-store`. Rule storage and event persistence failures stop
  tool execution. Explicit denials take precedence, and `requireApproval` requests
  always require a fresh decision.

  Expose trusted rule management and persistent approval resolution through
  Application and Workspace controllers. Persist rule events in Session history
  without adding them to model context. Add persistent approval ranges and rule
  management controls to terminal and Web UI components, with host-owned creator
  identity. Agent adapters accept trusted execution scopes and persistent approval
  metadata. Export workspace path checks for host permission policies.

  Provide `beforeCheck` for one-time execution preparation from immutable inputs,
  and keep Application tool previews separate from repeated permission evaluations.

  Add `apps.maybecode.persistentRules` and `apps.maybeclaw.persistentRules` to the
  configuration schema. Both default to false. MaybeCode stores project rules in
  `.may/permission-rules.json`; MaybeClaw stores them in its data directory and
  restricts management to operators.

  Compatibility: the public `ApprovalDecision`, `PermissionEvent` and
  `SessionEvent` unions gain variants. Exhaustive TypeScript consumers must add
  `allow-persistent` and `rule.created` / `rule.revoked` / `rule.used` handling.
  Access `requestId` only after narrowing to `approval.resolved` or
  `approval.cancelled`, and offer persistent approval only when request metadata
  exists. Supply a trusted `createdBy` identity when resolving it. Existing policy
  return values and existing Session histories remain supported. Readers of
  histories containing rule events must use the updated Session package.
- 89bcd8d: Add scoped plugin composition with typed versioned services, validated dependencies,
  configuration and state schemas, lifecycle Hooks, state migration, resource cleanup
  and serialized replacement. Agent definitions and applications accept plugins;
  MaybeCode and MaybeClaw can load plugin definitions from configuration.

  Expose replaceable AgentRuntime factories and runtime state persistence through
  Session. The default May runtime retains the existing direct API and integrates
  ordered Hooks around input, runs, steps, Context, models, tools, approvals and
  recovery. Durable records retain raw tool output and generated continuation inputs.

  Runtime identity and state versions are recorded in new Sessions. Existing May
  histories remain readable; resuming with an incompatible custom runtime requires
  an explicit migration. Plugin replacement waits for active operations, and failed
  replacement initialization prevents further execution until composition is repaired.

  Breaking change: validated tool argument objects and permission input snapshots
  are recursively frozen. Tools and policies must treat arguments as read-only.
  Mutable built-in containers such as Date, Map and Set are rejected at the tool
  argument boundary; use ordinary data objects and arrays to represent those values.
  Custom parsed instances retain their prototypes and methods and must protect any
  mutable internal state themselves.
- 63f68e5: Breaking change: package names use the `@sortedyuan` npm scope. Update dependency
  names, imports, pnpm filters, and configured module specifiers from `@may/` to
  `@sortedyuan/`, then reinstall dependencies. MaybeCode provides the `maybecode`
  command and its headless API through `@sortedyuan/maybecode`.

  Plugin IDs, saved Session data, configuration locations, and the Anthropic message
  state format retain their existing identities. OpenTelemetry instrumentation
  uses `@sortedyuan/observability`; update filters that select instrumentation by name.

  The TUI package includes the PNG declarations required by its image dependency,
  so consumers can type-check installed declarations with `skipLibCheck: false`.

### Patch Changes

- Updated dependencies [02789c6]
- Updated dependencies [422e404]
- Updated dependencies [88e7d69]
- Updated dependencies [88e7d69]
- Updated dependencies [0dc3f68]
- Updated dependencies [78bde1d]
- Updated dependencies [89bcd8d]
- Updated dependencies [63f68e5]
- Updated dependencies [88e7d69]
  - @sortedyuan/core@0.2.0
