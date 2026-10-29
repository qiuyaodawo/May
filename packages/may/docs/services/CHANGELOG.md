# @sortedyuan/plugin-services

## 0.3.0

### Minor Changes

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

### Patch Changes

- Updated dependencies
  - @sortedyuan/session@0.5.0

## 0.2.3

### Patch Changes

- Updated dependencies [941b411]
  - @sortedyuan/session@0.4.0

## 0.2.2

### Patch Changes

- Updated dependencies [749fadc]
  - @sortedyuan/session@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies [92fc3b9]
  - @sortedyuan/permissions@0.2.1

## 0.2.0

### Minor Changes

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

- Updated dependencies [88e7d69]
- Updated dependencies [1e9bdfc]
- Updated dependencies [8df2b63]
- Updated dependencies [02789c6]
- Updated dependencies [422e404]
- Updated dependencies [88e7d69]
- Updated dependencies [88e7d69]
- Updated dependencies [5d3b04a]
- Updated dependencies [0dc3f68]
- Updated dependencies [89bcd8d]
- Updated dependencies [78bde1d]
- Updated dependencies [89bcd8d]
- Updated dependencies [0dc3f68]
- Updated dependencies [c8c14c7]
- Updated dependencies [63f68e5]
- Updated dependencies [88e7d69]
  - @sortedyuan/session@0.2.0
  - @sortedyuan/plugin@0.2.0
  - @sortedyuan/context@0.2.0
  - @sortedyuan/core@0.2.0
  - @sortedyuan/skills@0.2.0
  - @sortedyuan/permissions@0.2.0
