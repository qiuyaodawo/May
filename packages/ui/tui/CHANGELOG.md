# @sortedyuan/tui

## 0.2.0

### Minor Changes

- 6a0bcd3: Add optional continuation indentation to Text and preserve RGB colors and combined ANSI styles when wrapping. Transcript notices retain indentation on continuation lines while selection copies the original text.
- 40dda8b: 增加 TranscriptStore.latestReply、TranscriptView.revealLatestReply、
  TranscriptView.latestReplyAnchor 和 ScrollView.scrollToAnchor，支持将当前轮次
  已经完成的最终回复正文开头显示在顶部，并保持阅读位置。支持历史会话恢复，
  明确保留选中回复的完整正文，支持超过通常滚动缓冲区长度的回复。
- 8df2b63: Add the Node-only application/git-workspace entry point for project Git checkpoints, coordinated request commits, persistent worktree management and reviewed file restoration. Add shared workspace status, reply fork and checkpoint diff data to UI hosts and clients, with keyboard history and diff components for terminal applications.
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
- 34b2532: 新增 `renderMarkdownExcerpt`，将 Markdown 转换为保留标题文字、列表、代码和链接的纯文本节选，支持可见字符数量与逻辑行数限制，并使用完整的 Unicode 字符和省略号表示截断。
- 296080a: Support Sixel image previews in retained and readline terminals, including
  Windows Terminal capability and cell-size queries. Resize previews to the
  available cells, preserve text input while processing terminal reports, and
  clear or redraw images when their viewport changes. Export TerminalImageSupport
  and cell-size options for reusable terminal integrations. Add Sixel encoding,
  image resizing, image-q palette generation and ANSI response parsing dependencies. Preserve pixel positions
  and cached source data by encoding an independent pixel buffer.
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
- 40dda8b: NodeTerminalDriver 在全屏界面启用鼠标报告，通过 tty-events 处理鼠标输入，
  并发送 wheelup、wheeldown KeyStroke。ScrollView 支持每次滚动三行。
  退出全屏界面时关闭鼠标报告。
- 81d6852: Add reusable mouse text selection, clipboard adapters, semantic component
  bindings, pointer routing and selection-aware editing. Preserve text positions
  through wrapping, conversation updates and resizing. Add clipboardy for local
  clipboard access, diff for stable selection positions during Markdown updates,
  and explicit OSC 52 output for remote terminals.

  Breaking: Editor Ctrl+A selects all text; use Home for the logical line start.
  Consumed boundary navigation now returns true even when the position is unchanged.
  Runtime disposes its root when stopped or replaced. Hosts should make dispose
  idempotent and use handleKeyResult to distinguish consumption from redraw.

  MaybeCode's private application uses Ctrl+G as its default leader and reserves
  Ctrl+X for cutting selected input. Update existing shortcut habits or configure
  MAY_TUI_LEADER; MAY_CLIPBOARD controls clipboard access. Ctrl+C copies selected
  text and interrupts only when there is no active selection.

  MaybeCode leader sequences wait until completion or cancellation without a time
  limit. Keymap accepts chordTimeoutMs: null for this policy. Scroll anchoring uses
  nonempty text ranges so repeated redraws preserve the reading position.

### Patch Changes

- 422e404: Add trusted Tool.workspaceEffect metadata, an approved-tool execution check, deferred
  Git workspace initialization, and lightweight repository summaries. Delegated Agents
  can share the host's execution check. Built-in file readers and session coordination
  tools declare that they preserve workspace files.

  MaybeCode prepares checkpoints immediately before the first approved modifying tool
  in each request, sharing preparation across main and delegated Agents and retaining
  the lease through Goal verification. Startup and read-only requests leave Git state
  unchanged. Each modifying request saves existing user edits before accepting tool writes.
- e3736f6: 加快 MaybeCode 启动：CLI 使用按功能加载的 JavaScript 打包文件，图片处理和 Web 服务在使用时加载。Git 初始化合并仓库身份与操作状态查询，并在 checkpoint 操作内复用状态结果，保留初始 checkpoint 和写入前检查。
- 3118666: `NodeTerminalDriver` 将独立 LF 输入识别为 `Ctrl+J`，支持应用绑定换行操作。
  CR 输入继续识别为 `Enter`，bracketed paste 中的换行保留为粘贴文字。
- Updated dependencies [c8c14c7]
- Updated dependencies [0dc3f68]
- Updated dependencies [b3980fd]
- Updated dependencies [88e7d69]
- Updated dependencies [1e9bdfc]
- Updated dependencies [8df2b63]
- Updated dependencies [02789c6]
- Updated dependencies [422e404]
- Updated dependencies [e3736f6]
- Updated dependencies [88e7d69]
- Updated dependencies [88e7d69]
- Updated dependencies [2a44905]
- Updated dependencies [5d3b04a]
- Updated dependencies [0dc3f68]
- Updated dependencies [78bde1d]
- Updated dependencies [89bcd8d]
- Updated dependencies [0dc3f68]
- Updated dependencies [63f68e5]
- Updated dependencies [cefc5e9]
- Updated dependencies [81d6852]
- Updated dependencies [88e7d69]
  - @sortedyuan/coding-tools@0.2.0
  - @sortedyuan/session@0.2.0
  - @sortedyuan/core@0.2.0
  - @sortedyuan/media@0.2.0
  - @sortedyuan/permissions@0.2.0
  - @sortedyuan/keybindings@0.2.0
