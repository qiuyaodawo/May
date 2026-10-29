# `@sortedyuan/may`

[English](README.md) | **简体中文**

提供可组合的 Agent 定义、执行、对话、权限与插件能力。

从根入口导入 `defineAgent()`，配置 Agent，并通过 Session 存储打开 Application。
每个 Application 管理自己的 Session 生命周期。

| 入口 | 功能 |
| --- | --- |
| `@sortedyuan/may` | Agent 定义、Application 和 Workspace |
| `@sortedyuan/may/core` | 模型与工具循环、接口、事件和预算 |
| `@sortedyuan/may/context` | 模型可见内容及压缩 |
| `@sortedyuan/may/session` | 对话历史、恢复与分支 |
| `@sortedyuan/may/session/file-store` | JSONL Session 存储 |
| `@sortedyuan/may/session/catalog` | Session 发现 |
| `@sortedyuan/may/storage` | 文件访问和写入者管理 |
| `@sortedyuan/may/permissions` | 工具策略与审批 |
| `@sortedyuan/may/plugin` | 作用域服务和 Hooks |
| `@sortedyuan/may/services` | Agent 服务定义与注册 |
| `@sortedyuan/may/config` | 配置加载与校验 |
| `@sortedyuan/may/skills` | Skills 发现与激活 |
| `@sortedyuan/may/goals` | 持久化目标执行 |
| `@sortedyuan/may/goals/plugin` | 目标插件 |
| `@sortedyuan/may/history-memory` | 历史引用记忆与压缩插件 |
| `@sortedyuan/may/application/git-workspace` | Git workspace 生命周期 |

需要 Node.js 22.16.0 或更新版本。文件存储和 Git 集成使用 Node API。
Core 入口可以独立导入。

参阅[构建 Agent](../../docs/zh-CN/guides/building-an-agent.md)和
[包参考](../../docs/zh-CN/reference/packages.md)。

模块参考包含 [Application](docs/application/README.zh-CN.md)、
[Core](docs/core/README.md)、[Context](docs/context/README.md)、
[Session](docs/session/README.md)、[存储](docs/storage/README.zh-CN.md)、
[权限](docs/permissions/README.md)、[插件](docs/plugin/README.zh-CN.md)、
[服务](docs/services/README.zh-CN.md)、[配置](docs/config/README.md)、
[Skills](docs/skills/README.md)、[目标执行](docs/goals/README.md)、
[目标插件](docs/goals-plugin/README.zh-CN.md)和
[历史记忆](docs/history-memory/README.zh-CN.md)。
