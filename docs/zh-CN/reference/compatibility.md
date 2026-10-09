# 兼容性与稳定性

[English](../../en/reference/compatibility.md) | **简体中文**

May 当前处于开发预览阶段。公共 API、协议表示和存储格式在 `1.0.0` 前可能变化。
每次升级需要阅读发布说明并重新编译使用方代码。本文说明当前兼容性范围。

## 支持的运行环境

发布的框架包要求 Node.js 22 或更高版本。MaybeClaw 要求 Node.js 22.13 或更高版本。
仓库开发要求 Node.js 22.16.0 或更高版本，离线测试使用该版本提供的 `node:sqlite`
backup API。仓库在 `package.json` 声明 pnpm 12.4.2，在 `.node-version` 推荐 Node.js 24。

CI 覆盖 Linux 的 Node.js 22/24 和 Windows/macOS 的 Node.js 24；包安装检查覆盖
Linux 与 Windows。选择部署环境时，查看工作流与目标包的 `engines`。验证命令见
[仓库开发](../guides/repository-development.md)。

## 公共 API 范围

仅使用包的 `exports` 声明的入口。`src/` 或 `dist/` 内未声明的路径属于内部实现。
导入类型时使用 type-only import：

```ts
import { AgentApplication, type AgentApplicationEvent } from "@may/application";
import type { ContextFactory } from "@may/context";
```

[包目录](packages.md)列出包职责与公共入口。提供弃用别名的 API 会单独记录说明；
预览版使用方需要检查每次发布的迁移要求。

### 组合对象

`ToolRegistry`、`DuplicateToolNameError`、`AgentDefinition` 和 `defineAgent()`
属于公共预览 API，其所有权规则如下：

- Registry 实例由调用方拥有。
- `May` 在构造时保存静态工具集合的成员。
- `AgentDefinition` 在创建时保存静态工具集合的成员。
- 直接使用 `AgentApplication.open()` 时，在打开期间保存静态成员。
- 普通查询与 `clone()` 保留原始 Tool 对象。
- 返回工具或模型定义的 Registry 操作检查注册时的名称、描述、schema 引用、parser、
  executor、`resultContent` 和 `permissionVersion`。替换这些字段会导致 `TypeError`。
  Schema 检查比较对象身份，调用方
  需要自行管理 schema 内部的修改。

每次 `AgentDefinition.open()` 创建独立的应用与 Session 生命周期。捕获的 Model、
Context factory、executor、scheduler、权限策略闭包及其他有状态对象仍由调用方
拥有；共享对象需要调用方提供并发隔离。应用负责重新构造 definition，Session
历史与元数据不保存其行为或当前权限策略。

### 每次 Run 的动态工具目录

`MayOptions.toolSource` 是可信宿主提供的同步 `() => Iterable<Tool>`，也由
`AgentApplication`、`defineAgent()` 和 `MaybeCodeApplication` 接受。每次
`run()` 或 `continue()` 启动时调用一次，将返回工具追加到静态集合。远程发现和
刷新需要在 Core 外完成，回调返回最新的内存集合。工具重名会在修改 Context 前报错。

`ToolRegistry.snapshot()` 创建冻结的 Tool 外观对象，并复制、冻结 schema。
同一 Run 的模型定义、调度、解析、权限和执行使用同一份快照；模型获得独立的
schema 副本。目录更新影响下一次 Run。Executor 收到 Run 外观对象；执行需要的
宿主元数据应放在 Tool 字段中。仅包含原始对象的 WeakMap 无法识别该外观对象。
捕获的回调保留原始 `this`，闭包状态继续共享。Schema 必须支持 structured clone。

`Tool.permissionVersion` 是可选的宿主身份字段，不进入模型定义。Session grant
将策略 `grantKey` 与规范化名称、描述、schema 及此版本关联。定义或宿主身份变化
需要重新审批；仅 schema 属性顺序变化不会使授权失效。`revokeSessionGrant(key)`
撤销该 key 的全部版本，明确禁止的策略优先。宿主版本需要包含影响执行的元数据、
端点和账户。详见[权限策略](../guides/permission-policy.md)。

## 事件与呈现数据

Run 和权限事件流提供实时观察。消费者处理过慢时，有界队列可能丢弃高频流式增量。
完成状态与已保存事实应通过终结生命周期事件、Run 结果和持久化 Session 历史获取。
详见[事件](../concepts/events.md)。

消费者需要处理未知事件类型。持久化的应用呈现数据使用 `kind` 和数字 `version`；
拒绝不支持的版本时保留 Session。变更预览 decoder 识别已有记录中的
`maybecode.change-preview`。该名称属于持久化格式标识，包依赖方向由导入关系定义。

## Session 持久化

文件 Session store 使用追加式 JSONL，要求每个 Session 同时只有一个写入者。
文件 Catalog 提供本地索引，通过原子追加的操作文件支持本地多个进程。
离线 `compact({ confirmHostsStopped: true })` 要求其他 Catalog 使用者已经停止。
字段布局、可选字段、目录命名和未来版本迁移均属于预览格式。恢复保证以当前实现
经过验证的行为为限。

使用公共存储 API 修改记录。需要外部 schema 的应用应实现 `SessionStore` 与
`SessionCatalog`，并管理自己的迁移策略。详见[自定义存储](../guides/custom-storage.md)
与[恢复](../guides/recovery.md)。

## Provider 自有状态

Adapter 可以在标准化消息上附加不透明的 `modelState`，用于继续 Provider 原生
对话或压缩。创建状态的 Adapter 负责解释该状态；其他 Adapter 使用标准化 May
消息。通过 Provider 目录解析模型能力，未知能力继续保持未知。

Provider HTTP API 与模型能力独立变化。能力覆盖与处理策略见
[配置参考](configuration.md)。

## 协作与团队

`@may/coordination` API、版本 1 快照日志、可选资源日志和远程 Worker 协议属于
预览格式。单个持久化 coordinator 拥有调度权，包括远程叶子任务。本地预算预留与
计账适用于该 coordinator。恢复时需要明确处理已保存的策略和限制变化。

MaybeCode 团队使用本地 Agent，默认执行只读工作。版本 2 提供持久化计划、有明确
范围的检查与报告，以及确认后的恢复操作。编码模式允许修改私有副本；将补丁应用
到源文件需要审查与准确的宿主确认。获准的检查进程使用宿主操作系统权限。
版本 1 团队保留只读 resume/status/cancel 行为。

并发与恢复限制见[协作](../guides/coordination.md)、
[资源](../guides/coordination-resources.md)、
[Attempt 与修订](../guides/coordination-lifecycle.md)、
[远程 Worker](../guides/coordination-remote.md)及
[MaybeCode 团队](../guides/maybecode-team.md)。

## MCP

`@may/mcp` 连接池选项、错误、名称空间、输出表示、状态、生命周期事件与 span 名称
属于预览 API。工具客户端支持 stdio、Streamable HTTP、明确的刷新与重新连接，以及
每次 Run 的目录。宿主选择的资源、模板和 prompt 作为用户内容进入对话。

模型可见名称使用 `mcp__<server>__<tool>`，按 Provider 要求规范化，最多 64 个字符。
保存的调用保留该名称。更改 server ID 或远程工具名后，历史调用可能无法找到对应的
可执行工具。

交互 broker 管理现代协议的表单与 URL elicitation，提供所有者范围、等待限制、
答案校验及继续执行前的身份检查。旧协议交互操作使用明确隔离的连接。
Roots/Sampling、Tasks、Apps Host 和独立 `@may/mcp/server` 导出需要分别启用并
配置服务。支持的协议与宿主职责见 [MCP](../guides/mcp.md)、
[长时间任务](../guides/mcp-tasks.md)、[Apps](../guides/mcp-apps.md)及
[编写 server](../guides/mcp-server.md)。

## Tracing

Core tracing 类型与 `@may/observability` 的 processor、exporter、采样、完成 span
结构、名称和属性属于预览 API。Trace 可能被采样或丢弃，包括 exporter 保存 span
的情况。权限、计费和审计决定应使用 Session 记录与应用自行维护的记录。

内置 instrumentation 不记录 prompt、message、reasoning 和工具输入输出。调用方
属性不会自动脱敏，需要限制大小并排除敏感信息。调用方拥有 tracer 与 processor
的生命周期，在对应所有权范围内关闭共享 processor；关闭应用不会关闭它们。

MaybeCode 的每日 trace JSONL 按本地日期轮转，默认保留 60 天。Span 格式继续属于
预览遥测。详见[可观测性](../guides/observability.md)。

## 安全范围

权限审批决定 Tool 是否可以执行。编码 shell Tool 使用 May 进程的权限。应用需要
限制不可信命令的执行范围时，使用独立沙箱或远程执行服务。

配置与 Session 记录可能包含敏感 prompt、工具数据和 Provider 状态。内置本地
Session store 不加密这些记录。

## 稳定发布要求

声明 `1.0.0` 前，需要为以下内容定义版本并编写说明：导出 API、Session/Catalog
迁移、呈现类型、事件演进、支持的 Node.js 与 Adapter 版本、tracing/exporter
兼容性、弃用与发布说明策略。
