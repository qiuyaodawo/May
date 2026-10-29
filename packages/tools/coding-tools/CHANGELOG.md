# @sortedyuan/coding-tools

## 0.3.0

### Minor Changes

- 437b090: Consolidate the framework into `@sortedyuan/may`, including Core, Application,
  Session, Context, permissions, configuration, storage, Skills, plugin hosting,
  services, goals and history memory. Provider implementations use subpaths of
  `@sortedyuan/providers`. Gateway adapters, RPC, delivery and HTTP services use
  `@sortedyuan/gateway`. Capability plugins use their owning package's public
  subpaths; TUI includes keybindings. Update all consumers to use the same framework
  module identities and runtime dependency chain.

  **Breaking:** Replace component dependencies and imports using
  `docs/en/guides/package-subpaths.md` or `docs/zh-CN/guides/package-subpaths.md`.
  Install `@sortedyuan/may` for framework imports such as
  `@sortedyuan/may/session/file-store`; install `@sortedyuan/providers` for protocol
  imports such as `@sortedyuan/providers/deepseek`. Rebuild applications and third-party
  plugins together. Preserve plugin IDs, service IDs, configuration data and saved
  Session state. MaybeCode carries the consolidated dependencies in its published
  installation; its command names remain unchanged.

### Patch Changes

- Updated dependencies [437b090]
- Updated dependencies [c23ff33]
- Updated dependencies [437b090]
- Updated dependencies [1dd118f]
- Updated dependencies [c23ff33]
- Updated dependencies [c23ff33]
- Updated dependencies [c23ff33]
  - @sortedyuan/may@0.1.0

## 0.2.0

### Minor Changes

- c8c14c7: Add `codingRuntimeInstructions` to generate workspace, operating system, shell syntax, session role and origin, and optional permission and assignment information. Shell runtime guidance now contains syntax instructions, and composed project instructions include their source file path.

  Preserve shell metadata across `ToolRegistry` snapshots so applications can include the available shell in runtime instructions after tool composition. Model-facing tool definitions retain their existing fields.
- 0dc3f68: `read`、`edit` 与 `write` 工具新增可选的 `guard` 选项。守卫收到已经过工作区路径保护
  解析的路径，并在同一把按规范化路径取得的锁内执行读取或修改，因此宿主可以把
  “读取并记录版本”“检查并写入”各自实现为一个完整操作边界，用于多个执行方共享
  同一个工作区的场景。读取返回模型实际看到的内容，写入返回最终写入的内容。
  `createCodingTool` 与 `createCodingTools` 接受同一个 `guard`，`workspaceFileKey`
  提供与工具一致的路径键（含 Windows 大小写处理）。不提供 `guard` 时行为不变。
- b3980fd: Breaking change: coding tools execute directly on the host. The `environment` option and the `environmentId` and `platform` fields on `WorkspacePath` have been removed. Configure tools with a host workspace `cwd` and select the shell executable through `ShellProfile`. Applications requiring execution isolation must provide it outside the coding tools.
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
- 63f68e5: Breaking change: package names use the `@sortedyuan` npm scope. Update dependency
  names, imports, pnpm filters, and configured module specifiers from `@may/` to
  `@sortedyuan/`, then reinstall dependencies. MaybeCode provides the `maybecode`
  command and its headless API through `@sortedyuan/maybecode`.

  Plugin IDs, saved Session data, configuration locations, and the Anthropic message
  state format retain their existing identities. OpenTelemetry instrumentation
  uses `@sortedyuan/observability`; update filters that select instrumentation by name.

  The TUI package includes the PNG declarations required by its image dependency,
  so consumers can type-check installed declarations with `skipLibCheck: false`.
- cefc5e9: Discover project instructions from the nearest project root through the startup workspace. Each directory selects a non-empty `AGENTS.override.md`, configured project filename, or fallback filename in that order. Preserve parent-to-child ordering and source paths while keeping the tool workspace unchanged.

  Expose the complete ordered `projects` list and `formatCodingProjectInstructions`; retain `project` as the nearest individual document. Add configurable project root markers and fallback filenames, and enforce a combined project-document size limit.

### Patch Changes

- 1e9bdfc: 修复 Session 文件对 `input.generated` 的读取校验，使 Hook 追加的继续执行消息和分支继承的已交付补充输入能够恢复。

  Plugin replacement 等待已接受的状态更新完成保存，并在替换准备期间拒绝新的状态写入。

  ContextController 新增可选的 `commitCompaction(result)`，用于标记替换后的 Context 已经成功保存。AgentApplication 在保存成功后调用该方法；完成 Hook 的错误继续传递，活动 Context 和持久化记录保持一致。

  Remote CoordinationWorker 将已保存的取消意图发送给分离的外部执行，并通过恢复查询确认结果。

  PowerShell shell 工具根据最后执行命令的状态返回 exitCode，失败的 cmdlet 返回非零值。
- 422e404: Add trusted Tool.workspaceEffect metadata, an approved-tool execution check, deferred
  Git workspace initialization, and lightweight repository summaries. Delegated Agents
  can share the host's execution check. Built-in file readers and session coordination
  tools declare that they preserve workspace files.

  MaybeCode prepares checkpoints immediately before the first approved modifying tool
  in each request, sharing preparation across main and delegated Agents and retaining
  the lease through Goal verification. Startup and read-only requests leave Git state
  unchanged. Each modifying request saves existing user edits before accepting tool writes.
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
