# 迁移到组件公开子路径

[English](../../en/guides/package-subpaths.md) | **简体中文**

应用或插件使用下表中的六个包时，按照本文更新。这是包路径的破坏性变更。
当前 workspace 提供下列子路径；从 registry 安装时，需要选择已经包含这些导出的
发布版本。升级之前检查目标包的 changelog。

| 原包 | 公开导入路径 | 安装依赖 |
| --- | --- | --- |
| `@sortedyuan/plugin-models` | `@sortedyuan/plugin-services/models` | `@sortedyuan/plugin-services` |
| `@sortedyuan/plugin-runtime` | `@sortedyuan/plugin-services/runtime` | `@sortedyuan/plugin-services` |
| `@sortedyuan/plugin-permissions` | `@sortedyuan/plugin-services/permissions` | `@sortedyuan/plugin-services` |
| `@sortedyuan/plugin-skills` | `@sortedyuan/plugin-services/skills` | `@sortedyuan/plugin-services` |
| `@sortedyuan/plugin-coordination` | `@sortedyuan/coordination/plugin` | `@sortedyuan/coordination` |
| `@sortedyuan/session-tools` | `@sortedyuan/session/tools` | `@sortedyuan/session` |

1. 将 `package.json` 中的原依赖替换为目标包，选择包含这些导出的版本。
   子路径用于导入，依赖名称使用最后一列中的包名。
2. 更新源码导入、重新导出、模块解析调用和配置中的模块路径。
   插件工厂继续返回 `PluginDefinition` 对象；配置加载的插件模块需要导出该对象。
3. 重新安装依赖并更新使用方项目的 lockfile，编译应用和使用这些 API 的插件包。
4. 在使用方应用中验证插件激活、资源清理和 Session 状态恢复。
   生命周期说明见[插件指南](plugins.md)。

下面的片段使用应用提供的实际 Model `model` 和已经打开的 Session `session`：

```ts
import { createModelPlugin } from "@sortedyuan/plugin-services/models";
import { createSessionHistoryTool } from "@sortedyuan/session/tools";

const plugin = createModelPlugin({ create: () => model });
const historyTool = createSessionHistoryTool({ source: session });
```

`plugin-services` 主入口导出服务标识、注册表和工厂元数据，组件工厂通过各自子路径
导入。插件继续独立管理身份、配置、激活和替换。函数名称、ServiceToken ID、插件 ID
及持久状态格式保持不变。已有 Session 和 Skill 状态无需转换；保留应用配置中明确
指定的插件 ID。

[发布清单](../../../scripts/release-packages.json)包含 38 个包，六个原包已经移出该清单。
仓库通过 `pnpm release:check`、指定外部目录的 `pnpm test:package:release` 和
`pnpm test:package:plugin` 验证。这些安装检查在仓库外安装 tarball，插件检查运行
公开子路径测试。命令见[发布验证指南](npm-release.md)。
