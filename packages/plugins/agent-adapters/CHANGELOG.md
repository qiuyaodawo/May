# @sortedyuan/plugin-agent-adapters

## 0.2.3

### Patch Changes

- Updated dependencies [941b411]
  - @sortedyuan/session@0.4.0
  - @sortedyuan/application@0.3.1
  - @sortedyuan/plugin-delivery@0.3.1

## 0.2.2

### Patch Changes

- Updated dependencies [749fadc]
- Updated dependencies [749fadc]
- Updated dependencies [749fadc]
  - @sortedyuan/application@0.3.0
  - @sortedyuan/plugin-delivery@0.3.0
  - @sortedyuan/session@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies [92fc3b9]
  - @sortedyuan/permissions@0.2.1
  - @sortedyuan/application@0.2.1

## 0.2.0

### Minor Changes

- 88e7d69: 增加经过验证的版本化执行关联信息，连接 scheduler、coordination、Agent adapter、
  Session、Run 与模型请求。Session 继续执行记录先前 Run 身份；远程业务去重独立于
  trace parent。Scheduler 可选启用遥测，并依赖 Core 的公开接口。

  增加可选 service 查询、本地诊断与独立指标服务，以及可复用的 UI 诊断面板。宿主可以
  按会话范围查询执行记录、刷新模型能力，并独立管理遥测资源。子 Agent 预算包装保留
  模型配置、能力版本和物理请求观察信息。
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
- 89bcd8d: Expose existing Agent functionality as reusable plugins with declared services,
  dependencies and managed resource lifecycles. Add shared typed service tokens and
  ordered tool, instruction, Model and Context contribution registries. Application
  direct options compose through plugin factories, and replacement services receive
  creation notifications for the active Application.

  Add plugin factories for runtime, Model, permissions, Skills, goals, historical
  Context, delegation, MCP, observability, durable delivery, Agent
  adapters, task coordination and HTTP listeners. MaybeCode and MaybeClaw use these
  factories for their application and workspace lifecycles. Existing direct APIs and
  application exports remain available. Configuration-selected providers replace
  product defaults by declared service or plugin identity.
  MCP commands, events and delegated Agent tools use the active service provider;
  Application-owned pools follow Session lifecycles and configured shared pools
  follow the workspace lifecycle.

  PluginContext exposes pluginOrder for deterministic contribution ordering.
  Model plugins may provide modelInfo for metadata and model presentation; configured
  applications derive Context budgets from the selected Model service.
  Breaking change: reserved `may.model.provider`, `may.model.name`,
  `may.model.adapter` and `may.model.profile` trace attributes are populated only
  from the active `modelInfo` service. Supply `createModelPlugin({ create, info })`
  to record these fields. Other caller-defined trace attributes remain supported.
  Lifecycle notifications reach Session plugins and their ancestor handlers.
  Adapter release removes cached instances; coordination release relinquishes
  runtime resources. HTTP shutdown drains requests and closes connections before
  disposing product services. Packaged consumers can install each public plugin's
  complete runtime dependency chain independently of the repository.
  The public RPC file Agent example serializes state reads and writes, supports
  concurrent steering and cancellation, and preserves saved inputs after restart.

  Skills state is saved through versioned plugin state while existing Session
  activation records remain readable. Goals and history-memory retain their existing
  durable state records for migration.
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

- Updated dependencies [0dc3f68]
- Updated dependencies [88e7d69]
- Updated dependencies [1e9bdfc]
- Updated dependencies [8df2b63]
- Updated dependencies [02789c6]
- Updated dependencies [c8c14c7]
- Updated dependencies [8df2b63]
- Updated dependencies [2a44905]
- Updated dependencies [422e404]
- Updated dependencies [e3736f6]
- Updated dependencies [88e7d69]
- Updated dependencies [88e7d69]
- Updated dependencies [5d3b04a]
- Updated dependencies [0dc3f68]
- Updated dependencies [89bcd8d]
- Updated dependencies [78bde1d]
- Updated dependencies [89bcd8d]
- Updated dependencies [0dc3f68]
- Updated dependencies [63f68e5]
- Updated dependencies [88e7d69]
  - @sortedyuan/application@0.2.0
  - @sortedyuan/session@0.2.0
  - @sortedyuan/plugin@0.2.0
  - @sortedyuan/core@0.2.0
  - @sortedyuan/permissions@0.2.0
  - @sortedyuan/plugin-delivery@0.2.0
