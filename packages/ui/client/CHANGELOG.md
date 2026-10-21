# @sortedyuan/ui-client

## 0.2.4

### Patch Changes

- Updated dependencies
  - @sortedyuan/session@0.5.0
  - @sortedyuan/application@0.3.2
  - @sortedyuan/media@0.3.2

## 0.2.3

### Patch Changes

- Updated dependencies [941b411]
  - @sortedyuan/session@0.4.0
  - @sortedyuan/application@0.3.1
  - @sortedyuan/media@0.3.1

## 0.2.2

### Patch Changes

- Updated dependencies [749fadc]
- Updated dependencies [749fadc]
  - @sortedyuan/application@0.3.0
  - @sortedyuan/media@0.3.0
  - @sortedyuan/session@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies [92fc3b9]
  - @sortedyuan/permissions@0.2.1
  - @sortedyuan/application@0.2.1

## 0.2.0

### Minor Changes

- 02789c6: Export BrowserLogin from the server entry point so product servers can share
  single-use browser login tickets when composing UI and product API routes.
- 88e7d69: 增加经过验证的版本化执行关联信息，连接 scheduler、coordination、Agent adapter、
  Session、Run 与模型请求。Session 继续执行记录先前 Run 身份；远程业务去重独立于
  trace parent。Scheduler 可选启用遥测，并依赖 Core 的公开接口。

  增加可选 service 查询、本地诊断与独立指标服务，以及可复用的 UI 诊断面板。宿主可以
  按会话范围查询执行记录、刷新模型能力，并独立管理遥测资源。子 Agent 预算包装保留
  模型配置、能力版本和物理请求观察信息。
- 8df2b63: Add the Node-only application/git-workspace entry point for project Git checkpoints, coordinated request commits, persistent worktree management and reviewed file restoration. Add shared workspace status, reply fork and checkpoint diff data to UI hosts and clients, with keyboard history and diff components for terminal applications.
- c98ec03: MaybeCode 的两个终端界面支持 `/web`，自动打开浏览器并连接当前工作区与 Session。
  终端和 Web 共享执行状态及审批，退出终端时关闭 Web 服务。

  共享 UI 支持独立事件订阅、由外部宿主管理 controller 生命周期，以及短时有效的
  一次性浏览器连接凭据。浏览器自动兑换控制令牌，并在兑换前清除 URL fragment。
- 2a44905: Preserve ordered image replies from OpenAI Responses and expose reusable raster
  attachment validation, storage and reading. Terminal views support Kitty/iTerm2
  graphics and saved-file information; Web UI provides session-scoped authenticated
  image access, viewing and downloads. Hosts can supply custom media readers.
  Existing text-only consumers remain compatible.
- 02789c6: Expose optional host status badges in UI snapshots and render them in the fixed
  Web UI header, including on narrow screens. Add the MaybeCode permissionMode
  configuration schema for default approvals and opt-in YOLO auto-approval.
  The line-oriented terminal can update an active prompt while preserving its
  input and cursor, allowing connected views to keep status indicators current.

  MaybeCode supports --yolo, --no-yolo and /yolo [on|off|status], preserves explicit
  policy denials, and displays the current mode in terminal and Web UI sessions.
  The bare /yolo command enables the mode; /yolo status reports it without changes.
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
- 78bde1d: `UiSnapshot` 增加可选的 `resourcesVersion`。资源成员、分页顺序或搜索文本变化时，
  Web UI 保留搜索条件及已加载页数，重新读取资源列表。支持完整目录中的新增、删除和重命名。
- 63f68e5: Breaking change: package names use the `@sortedyuan` npm scope. Update dependency
  names, imports, pnpm filters, and configured module specifiers from `@may/` to
  `@sortedyuan/`, then reinstall dependencies. MaybeCode provides the `maybecode`
  command and its headless API through `@sortedyuan/maybecode`.

  Plugin IDs, saved Session data, configuration locations, and the Anthropic message
  state format retain their existing identities. OpenTelemetry instrumentation
  uses `@sortedyuan/observability`; update filters that select instrumentation by name.

  The TUI package includes the PNG declarations required by its image dependency,
  so consumers can type-check installed declarations with `skipLibCheck: false`.
- 02789c6: Display delivered steering messages consistently in live transcripts and restored
  Session history, preserving FIFO order and stable message identities. Include
  complete steering text in Web history search and field reads while retaining
  bounded snapshot previews.
- 095f958: WebUI 侧栏支持确认删除其它会话。垃圾桶图标在鼠标悬停或键盘聚焦时显示，
  触屏设备保持显示。当前会话禁止删除。执行或等待 MCP 交互期间禁用会话切换、
  新建和删除。

  确认等主操作按钮在悬停时保持主题背景色和清晰文字。

  兼容性变更：会话页面跟随宿主当前会话，UiClient.select(id) 执行 session.activate，
  selectedId 与 activeId 相同。终端和多个页面同步显示会话切换。客户端和宿主需要
  同步升级；程序调用方通过 select(id) 切换会话，通过 history/field API 读取历史。
  session.delete 使用 targetId 指定删除对象，并要求 expectedActiveId 校验当前会话。
  任务页面保留独立选择。
- 396ffb8: MaybeCode Web UI 支持共享斜杠命令及补全、effort、默认模型、会话管理、
  Skills、MCP、恢复处置和确认退出宿主。MCP 表单、review 和 URL 交互可在
  Web 或 TUI 完成，独立 Web 启动同样启用交互。

  /web 命令使用英文描述，与其它斜杠命令保持一致。

  共享 UI 增加命令结果、操作按钮、补全和交互协议。命令等待期间可以读取状态、
  提交交互响应和取消操作；命令输出及交互内容保存在页面内存中。

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
- Updated dependencies [2a44905]
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
  - @sortedyuan/core@0.2.0
  - @sortedyuan/media@0.2.0
  - @sortedyuan/permissions@0.2.0
