# @sortedyuan/maybecode

## 0.3.2

### Patch Changes

- 将组件插件工厂、Coordination 插件和 Session 历史工具集中到所属包的公开子路径。
  Application 与 MaybeCode 使用新的导入及运行时依赖。公开发布范围为 38 个包。

  这是包路径的破坏性变更。使用方需要更新依赖声明、源码导入及加载这些模块的配置：

  | 原包 | 公开子路径 | 需要安装的包 |
  | --- | --- | --- |
  | `@sortedyuan/plugin-models` | `@sortedyuan/plugin-services/models` | `@sortedyuan/plugin-services` |
  | `@sortedyuan/plugin-runtime` | `@sortedyuan/plugin-services/runtime` | `@sortedyuan/plugin-services` |
  | `@sortedyuan/plugin-permissions` | `@sortedyuan/plugin-services/permissions` | `@sortedyuan/plugin-services` |
  | `@sortedyuan/plugin-skills` | `@sortedyuan/plugin-services/skills` | `@sortedyuan/plugin-services` |
  | `@sortedyuan/plugin-coordination` | `@sortedyuan/coordination/plugin` | `@sortedyuan/coordination` |
  | `@sortedyuan/session-tools` | `@sortedyuan/session/tools` | `@sortedyuan/session` |

  选择包含这些子路径的发布版本，重新安装依赖并编译使用方。六个原包从本仓库的发布清单移除。
  插件 ID、ServiceToken ID、持久状态格式、函数名称及生命周期行为保持不变。
  迁移说明见 `docs/zh-CN/guides/package-subpaths.md` 和 `docs/en/guides/package-subpaths.md`。
- Updated dependencies
  - @sortedyuan/plugin-services@0.3.0
  - @sortedyuan/coordination@0.4.0
  - @sortedyuan/session@0.5.0
  - @sortedyuan/application@0.3.2
  - @sortedyuan/plugin-delegation@0.2.4
  - @sortedyuan/plugin-goals@0.2.4
  - @sortedyuan/plugin-history-memory@0.2.4
  - @sortedyuan/plugin-mcp@0.2.4
  - @sortedyuan/plugin-observability@0.2.4
  - @sortedyuan/config@0.3.2
  - @sortedyuan/mcp@0.2.3
  - @sortedyuan/media@0.3.2
  - @sortedyuan/ui-client@0.2.4
  - @sortedyuan/tui@0.2.4
  - @sortedyuan/web-ui@0.2.4
  - @sortedyuan/providers@0.2.3

## 0.3.1

### Patch Changes

- 941b411: Coordinate writer-lock creation and deletion for Team verification and patch application across processes. Include coordinated MCP credential, configuration and Git workspace lock lifecycles. Upgrade all processes sharing data together and retain `.lock.access` and `.lock.access.gate` during use and recovery.
- Updated dependencies [941b411]
  - @sortedyuan/session@0.4.0
  - @sortedyuan/mcp@0.2.2
  - @sortedyuan/application@0.3.1
  - @sortedyuan/config@0.3.1
  - @sortedyuan/coordination@0.3.1
  - @sortedyuan/media@0.3.1
  - @sortedyuan/plugin-services@0.2.3
  - @sortedyuan/plugin-delegation@0.2.3
  - @sortedyuan/plugin-history-memory@0.2.3
  - @sortedyuan/ui-client@0.2.3
  - @sortedyuan/tui@0.2.3
  - @sortedyuan/web-ui@0.2.3
  - @sortedyuan/plugin-mcp@0.2.3
  - @sortedyuan/plugin-goals@0.2.3
  - @sortedyuan/plugin-observability@0.2.3
  - @sortedyuan/providers@0.2.2
  - @sortedyuan/plugin-models@0.2.3
  - @sortedyuan/plugin-permissions@0.2.3
  - @sortedyuan/plugin-runtime@0.2.3
  - @sortedyuan/plugin-skills@0.2.3

## 0.3.0

### Minor Changes

- 749fadc: Coordinate team manifest, status, acceptance, and cancellation file access across processes so concurrent status queries can coexist with team command updates on Windows.

  Breaking change: initial access creates empty `.access` and `.access.gate` coordination files and needs directory write permission. Subsequent readers open both files read-only. To migrate existing records, run `team status <id>` once with directory write permission before granting read-only directory access, and retain both coordination files while the records are in use.

### Patch Changes

- Updated dependencies [749fadc]
- Updated dependencies [749fadc]
- Updated dependencies [749fadc]
- Updated dependencies [749fadc]
  - @sortedyuan/config@0.3.0
  - @sortedyuan/application@0.3.0
  - @sortedyuan/media@0.3.0
  - @sortedyuan/mcp@0.2.1
  - @sortedyuan/coordination@0.3.0
  - @sortedyuan/session@0.3.0
  - @sortedyuan/plugin-delegation@0.2.2
  - @sortedyuan/providers@0.2.1
  - @sortedyuan/plugin-goals@0.2.2
  - @sortedyuan/plugin-history-memory@0.2.2
  - @sortedyuan/plugin-mcp@0.2.2
  - @sortedyuan/plugin-observability@0.2.2
  - @sortedyuan/ui-client@0.2.2
  - @sortedyuan/web-ui@0.2.2
  - @sortedyuan/tui@0.2.2
  - @sortedyuan/plugin-services@0.2.2
  - @sortedyuan/plugin-models@0.2.2
  - @sortedyuan/plugin-permissions@0.2.2
  - @sortedyuan/plugin-runtime@0.2.2
  - @sortedyuan/plugin-skills@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [92fc3b9]
  - @sortedyuan/permissions@0.2.1
  - @sortedyuan/observability@0.2.1
  - @sortedyuan/application@0.2.1
  - @sortedyuan/coordination@0.2.1
  - @sortedyuan/plugin-services@0.2.1
  - @sortedyuan/plugin-delegation@0.2.1
  - @sortedyuan/plugin-permissions@0.2.1
  - @sortedyuan/ui-client@0.2.1
  - @sortedyuan/tui@0.2.1
  - @sortedyuan/plugin-observability@0.2.1
  - @sortedyuan/plugin-goals@0.2.1
  - @sortedyuan/plugin-history-memory@0.2.1
  - @sortedyuan/plugin-mcp@0.2.1
  - @sortedyuan/web-ui@0.2.1
  - @sortedyuan/plugin-models@0.2.1
  - @sortedyuan/plugin-runtime@0.2.1
  - @sortedyuan/plugin-skills@0.2.1

## 0.2.0

### Minor Changes

- 6a0bcd3: 新增 `delegationNotifications` 配置及 `/delegations notifications on|off|status` 命令，控制当前进程中的子 Agent 状态通知，默认关闭。设置在 Session 切换后保留，命令不修改配置文件。委派查询显示任务状态、文件、Run 和用量信息。
- a9c8481: Switch models and change reasoning effort through plugin updates within the existing application and Session. Refresh model-dependent services and event subscriptions while preserving conversation history, paused goals, active skills, durable notes, and YOLO approvals. Keep shared MCP resources alive and release application-owned plugin resources during updates.

  Expose `MaybeCodeApplication.updateModel()` and `modelUpdateFailed` for hosts that manage model selection. Failed updates stop new input until a successful model-update retry.
- c98ec03: MaybeCode 的两个终端界面支持 `/web`，自动打开浏览器并连接当前工作区与 Session。
  终端和 Web 共享执行状态及审批，退出终端时关闭 Web 服务。

  共享 UI 支持独立事件订阅、由外部宿主管理 controller 生命周期，以及短时有效的
  一次性浏览器连接凭据。浏览器自动兑换控制令牌，并在兑换前清除 URL fragment。
- 63f68e5: Breaking change: package names use the `@sortedyuan` npm scope. Update dependency
  names, imports, pnpm filters, and configured module specifiers from `@may/` to
  `@sortedyuan/`, then reinstall dependencies. MaybeCode provides the `maybecode`
  command and its headless API through `@sortedyuan/maybecode`.

  Plugin IDs, saved Session data, configuration locations, and the Anthropic message
  state format retain their existing identities. OpenTelemetry instrumentation
  uses `@sortedyuan/observability`; update filters that select instrumentation by name.

  The TUI package includes the PNG declarations required by its image dependency,
  so consumers can type-check installed declarations with `skipLibCheck: false`.
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

- 307cef9: Allow MaybeCode applications to start with custom tools by reading their registered tool catalog once when generating runtime instructions.
- 9056905: Delete unused Sessions created during the current MaybeCode launch on normal exit so they no longer appear in `/resume`. Preserve Sessions with submitted or queued messages or Runs, resumed Sessions, and historical forks.
- e3736f6: 加快 MaybeCode 启动：CLI 使用按功能加载的 JavaScript 打包文件，图片处理和 Web 服务在使用时加载。Git 初始化合并仓库身份与操作状态查询，并在 checkpoint 操作内复用状态结果，保留初始 checkpoint 和写入前检查。
- Updated dependencies [02789c6]
- Updated dependencies [02789c6]
- Updated dependencies [0dc3f68]
- Updated dependencies [02789c6]
- Updated dependencies [c8c14c7]
- Updated dependencies [0dc3f68]
- Updated dependencies [b3980fd]
- Updated dependencies [6a0bcd3]
- Updated dependencies [0dc3f68]
- Updated dependencies [0dc3f68]
- Updated dependencies [88e7d69]
- Updated dependencies [1e9bdfc]
- Updated dependencies [8df2b63]
- Updated dependencies [02789c6]
- Updated dependencies [c8c14c7]
- Updated dependencies [78bde1d]
- Updated dependencies [40dda8b]
- Updated dependencies [02789c6]
- Updated dependencies [8df2b63]
- Updated dependencies [8df2b63]
- Updated dependencies [ef3b26a]
- Updated dependencies [2a44905]
- Updated dependencies [422e404]
- Updated dependencies [02789c6]
- Updated dependencies [e3736f6]
- Updated dependencies [c98ec03]
- Updated dependencies [88e7d69]
- Updated dependencies [88e7d69]
- Updated dependencies [c8c14c7]
- Updated dependencies [2a44905]
- Updated dependencies [02789c6]
- Updated dependencies [5d3b04a]
- Updated dependencies [34b2532]
- Updated dependencies [0dc3f68]
- Updated dependencies [78bde1d]
- Updated dependencies [89bcd8d]
- Updated dependencies [78bde1d]
- Updated dependencies [89bcd8d]
- Updated dependencies [0dc3f68]
- Updated dependencies [296080a]
- Updated dependencies [c8c14c7]
- Updated dependencies [63f68e5]
- Updated dependencies [cefc5e9]
- Updated dependencies [02789c6]
- Updated dependencies [02789c6]
- Updated dependencies [3118666]
- Updated dependencies [40dda8b]
- Updated dependencies [81d6852]
- Updated dependencies [88e7d69]
- Updated dependencies [93ab677]
- Updated dependencies [095f958]
- Updated dependencies [396ffb8]
- Updated dependencies [02789c6]
  - @sortedyuan/config@0.2.0
  - @sortedyuan/web-ui@0.2.0
  - @sortedyuan/application@0.2.0
  - @sortedyuan/ui-client@0.2.0
  - @sortedyuan/coding-tools@0.2.0
  - @sortedyuan/tui@0.2.0
  - @sortedyuan/coordination@0.2.0
  - @sortedyuan/session@0.2.0
  - @sortedyuan/plugin-observability@0.2.0
  - @sortedyuan/plugin-delegation@0.2.0
  - @sortedyuan/plugin@0.2.0
  - @sortedyuan/context@0.2.0
  - @sortedyuan/core@0.2.0
  - @sortedyuan/goal@0.2.0
  - @sortedyuan/observability@0.2.0
  - @sortedyuan/plugin-goals@0.2.0
  - @sortedyuan/providers@0.2.0
  - @sortedyuan/skills@0.2.0
  - @sortedyuan/plugin-history-memory@0.2.0
  - @sortedyuan/media@0.2.0
  - @sortedyuan/permissions@0.2.0
  - @sortedyuan/plugin-services@0.2.0
  - @sortedyuan/plugin-runtime@0.2.0
  - @sortedyuan/plugin-models@0.2.0
  - @sortedyuan/plugin-permissions@0.2.0
  - @sortedyuan/plugin-skills@0.2.0
  - @sortedyuan/plugin-mcp@0.2.0
  - @sortedyuan/keybindings@0.2.0
  - @sortedyuan/mcp@0.2.0
