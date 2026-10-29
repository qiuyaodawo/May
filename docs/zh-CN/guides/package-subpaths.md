# 迁移到组件公开子路径

[English](../../en/guides/package-subpaths.md) | **简体中文**

应用或插件使用下表中的组件包时，按照本文更新。这是包路径的破坏性变更。
当前 workspace 提供下列子路径；从 registry 安装时，需要选择已经包含这些导出的
发布版本。升级之前检查目标包的 changelog。

| 原包 | 公开导入路径 | 安装依赖 |
| --- | --- | --- |
| `@sortedyuan/application` | `@sortedyuan/may` 或 `@sortedyuan/may/application` | `@sortedyuan/may` |
| `@sortedyuan/core` | `@sortedyuan/may/core` | `@sortedyuan/may` |
| `@sortedyuan/context` | `@sortedyuan/may/context` | `@sortedyuan/may` |
| `@sortedyuan/session` | `@sortedyuan/may/session` | `@sortedyuan/may` |
| `@sortedyuan/permissions` | `@sortedyuan/may/permissions` | `@sortedyuan/may` |
| `@sortedyuan/config` | `@sortedyuan/may/config` | `@sortedyuan/may` |
| `@sortedyuan/skills` | `@sortedyuan/may/skills` | `@sortedyuan/may` |
| `@sortedyuan/file-storage` | `@sortedyuan/may/storage` | `@sortedyuan/may` |
| `@sortedyuan/plugin` | `@sortedyuan/may/plugin` | `@sortedyuan/may` |
| `@sortedyuan/plugin-services` | `@sortedyuan/may/services` | `@sortedyuan/may` |
| `@sortedyuan/goal` | `@sortedyuan/may/goals` | `@sortedyuan/may` |
| `@sortedyuan/plugin-goals` | `@sortedyuan/may/goals/plugin` | `@sortedyuan/may` |
| `@sortedyuan/plugin-history-memory` | `@sortedyuan/may/history-memory` | `@sortedyuan/may` |
| `@sortedyuan/provider-<protocol>` | `@sortedyuan/providers/<protocol>` | `@sortedyuan/providers` |
| `@sortedyuan/plugin-delegation` | `@sortedyuan/coordination/delegation` | `@sortedyuan/coordination` |
| `@sortedyuan/plugin-mcp` | `@sortedyuan/mcp/plugin` | `@sortedyuan/mcp` |
| `@sortedyuan/plugin-observability` | `@sortedyuan/observability/plugin` | `@sortedyuan/observability` |
| `@sortedyuan/plugin-agent-adapters` | `@sortedyuan/gateway/adapters` | `@sortedyuan/gateway` |
| `@sortedyuan/plugin-agent-adapters/rpc` | `@sortedyuan/gateway/rpc` | `@sortedyuan/gateway` |
| `@sortedyuan/plugin-delivery` | `@sortedyuan/gateway/delivery` | `@sortedyuan/gateway` |
| `@sortedyuan/plugin-web-api` | `@sortedyuan/gateway/web-api` | `@sortedyuan/gateway` |
| `@sortedyuan/keybindings` | `@sortedyuan/tui/keybindings` | `@sortedyuan/tui` |
| `@sortedyuan/plugin-models` | `@sortedyuan/may/services/models` | `@sortedyuan/may` |
| `@sortedyuan/plugin-runtime` | `@sortedyuan/may/services/runtime` | `@sortedyuan/may` |
| `@sortedyuan/plugin-permissions` | `@sortedyuan/may/services/permissions` | `@sortedyuan/may` |
| `@sortedyuan/plugin-skills` | `@sortedyuan/may/services/skills` | `@sortedyuan/may` |
| `@sortedyuan/plugin-coordination` | `@sortedyuan/coordination/plugin` | `@sortedyuan/coordination` |
| `@sortedyuan/session-tools` | `@sortedyuan/may/session/tools` | `@sortedyuan/may` |

Application、Session、Context、权限和配置的已有导出后缀保持不变，例如
`@sortedyuan/may/application/git-workspace`、`@sortedyuan/may/session/file-store`
和 `@sortedyuan/may/config/schema`。`plugin-services/models`、`runtime`、
`permissions` 和 `skills` 分别使用 `may/services/models`、`runtime`、
`permissions` 和 `skills`。Provider 协议包括 `openai`、`openai-compatible`、
`anthropic`、`gemini`、`deepseek`、`kimi` 和 `zhipu`。OpenAI-compatible HTTP
辅助函数使用 `@sortedyuan/providers/openai-compatible/http`。
RPC 示例使用 `@sortedyuan/gateway/examples/rpc-file-agent`。

1. 将 `package.json` 中的原依赖替换为目标包，选择包含这些导出的版本。
   子路径用于导入，依赖名称使用最后一列中的包名。
2. 更新源码导入、重新导出、模块解析调用和配置中的模块路径。
   插件工厂继续返回 `PluginDefinition` 对象；配置加载的插件模块需要导出该对象。
3. 重新安装依赖并更新使用方项目的 lockfile，编译应用和使用这些 API 的插件包。
4. 在使用方应用中验证插件激活、资源清理和 Session 状态恢复。
   生命周期说明见[插件指南](plugins.md)。

下面的片段使用应用提供的实际 Model `model` 和已经打开的 Session `session`：

```ts
import { createModelPlugin } from "@sortedyuan/may/services/models";
import { createSessionHistoryTool } from "@sortedyuan/may/session/tools";

const plugin = createModelPlugin({ create: () => model });
const historyTool = createSessionHistoryTool({ source: session });
```

`@sortedyuan/may/services` 导出服务标识、注册表和工厂元数据，组件工厂通过各自子路径
导入。插件继续独立管理身份、配置、激活和替换。函数名称、ServiceToken ID、插件 ID
及持久状态格式保持不变。已有 Session 和 Skill 状态无需转换；保留应用配置中明确
指定的插件 ID。

[发布清单](../../../scripts/release-packages.json)包含 14 个包，Telegram 和 Feishu
渠道属于 MaybeClaw 的内部模块。
仓库通过 `pnpm release:check`、指定外部目录的 `pnpm test:package:release` 和
`pnpm test:package:plugin` 验证。这些安装检查在仓库外安装 tarball，插件检查运行
公开子路径测试。命令见[发布验证指南](npm-release.md)。
