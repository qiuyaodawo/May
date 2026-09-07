# 兼容性与稳定性

[English](../../en/reference/compatibility.md) | **简体中文**

May 当前是开发预览框架。所有 workspace package 版本均为 `0.1.0`；项目尚不承诺
长期的源码、二进制、wire format 或持久化兼容性。

本文说明调用方目前可以依赖的边界，以及仍需为哪些变化做准备。

## 公共 API 边界

只有 package `exports` map 声明的入口属于公共 API。即使本地存在某个文件，直接从
`src/`、`dist/` 或其他未声明的深层路径导入也不受支持。

对于契约和依赖注入，应优先使用 type-only import，而不是访问内部实现：

```ts
import {
  AgentApplication,
  type AgentApplicationEvent,
} from "@may/application";
import type { ContextFactory } from "@may/context";
```

当前 API 在 `1.0.0` 前可能变化。重命名 API 时，May 会在可行情况下提供文档化的
deprecated alias 或 adapter，但预览版用户仍应阅读每次发布说明并重新编译。

### 组合对象

`ToolRegistry`、`DuplicateToolNameError`、`AgentDefinition` 和 `defineAgent()` 都通过
各自 package 的根入口导出，但仍服从同一套 `0.1.0` 开发预览兼容策略。

`@may/core` 的 `ToolRegistry` 是调用方创建的实例，不是进程全局 registry。它实现
`Iterable<Tool>`；`May` 在构造时消费 iterable 并保存当时的成员，因此之后注册到源
registry 的工具不会出现在已有 runtime 中。重名由 `DuplicateToolNameError` 明确拒绝，
不会以后注册者覆盖前者。

Registry 保留原始 `Tool` 对象身份，但会在注册时保存其 readonly descriptor：名称、
描述、schema 引用、parser 和 executor。若这些字段随后被替换，需要返回/迭代工具或
生成模型定义的 registry 操作会抛出 `TypeError`。Schema 只按引用检查且不会深度冻结；
调用方必须让 descriptor 保持稳定，并自行管理 Tool 的其他内部状态。

`@may/application` 的 `AgentDefinition`/`defineAgent()` 在 definition 创建时同样消费并
快照工具 iterable。每次 `definition.open({ store, ... })` 都创建独立的 application 与
Session 生命周期；Session id、恢复选项和 metadata 不属于 definition。直接调用
`AgentApplication.open()` 时，则在打开期间快照 iterable。

这些快照是**集合和部分 option 容器的浅快照**，并非任意协作者的序列化或深克隆。
`Model`、`ContextFactory`、`ToolExecutor`、`ToolScheduler`、policy closure 和 `Tool`
对象仍由调用方拥有；同一 definition 多次打开时会有意共享它们。不要依赖 May 自动
隔离有状态 adapter，也不要把 `AgentDefinition` 当作可持久化 wire format。需要跨进程
保存 definition 的产品应定义自己的带版本配置格式，并在恢复时重新构造这些对象。

### Tracing 契约

Core 的 `Tracer`、`TraceSpan`、`TraceContext`、attribute 与传播字段是公共预览契约。
`@may/observability` 的 processor、exporter、采样函数、完成 span 结构、span name 和
attribute name 同样属于预览 API，在 `1.0.0` 前可能演进。

Tracing 有意采用 fail-open、非权威语义。即使 exporter 会持久化 span，它仍允许采样或
丢弃，因此调用方不能把它当成 Session、权限、计费或安全审计的事实来源。内置
instrumentation 不记录 prompt、message、reasoning 和工具输入输出；调用方提供的
attribute 不会自动脱敏，必须保持有界且不含敏感数据。

Tracer 与 processor 生命周期由调用方拥有。关闭 `AgentApplication` 不会 flush 或
shutdown 共享 processor；产品必须在真正的 ownership 边界只执行一次。

### MCP 契约

`@may/mcp` 的 client-pool option、错误码、namespace、工具输出结构、server 状态、
生命周期事件和 span name 都是开发预览 API。当前支持 stdio / Streamable HTTP tool
client、动态元数据目录、每 Run 工具快照及显式刷新/重连。资源/模板、prompt、补全
和 watch 为宿主驱动 API，选中内容以 user message 附加而非高权限指令。详见 [MCP 指南](../guides/mcp.md)。

模型可见名称目前使用 `mcp__<server>__<tool>`，执行 provider-safe 归一化并限制为
64 个字符。持久 Session 可以在工具调用和结果中包含这些名称，因此修改 server id
或远程工具名后，历史调用可能只剩描述意义，不再对应当前可执行 capability。

## 事件

Run 和 permission stream 是实时观察通道。消费者过慢时，有界队列可能丢弃高频
streaming delta；终结生命周期事件、返回的 Run 结果和持久化 Session 事实不得依赖
每个 delta 都被保留。

消费者应防御性处理未来未知的事件 variant。持久化的应用呈现数据使用 `kind` 和
数字 `version`；decoder 应拒绝不支持的版本，但不能破坏 Session。

编码变更预览 decoder 有意兼容历史名称 `maybecode.change-preview`。该 wire name
用于兼容既有 Session，不代表框架 package 反向依赖 MaybeCode 应用。

## Session 持久化

文件 Session store 使用 append-oriented JSONL，文件 Catalog 是轻量本地索引。它们
面向本地开发和每个 Session 单活动 writer，不适用于分布式或多主机协调。

以下内容尚不是稳定存储契约：

- 精确 JSON 字段布局和可选字段；
- 磁盘目录命名；
- 任意未来版本之间的迁移；
- 超出当前测试覆盖范围的崩溃恢复保证；
- 多进程或多主机并发写入。

不要手工编辑这些文件。需要稳定外部 schema 的应用应在公共接口后实现自己的
`SessionStore` 与 `SessionCatalog`，并自行管理迁移策略。参阅
[自定义存储](../guides/custom-storage.md)。

MaybeCode 的可选每日 trace JSONL 是 append-only 本地数据；它按本地日历日期轮转，
默认保留 60 天，但完成 span 的 JSON 结构和 attribute name 仍属于预览遥测契约，
不是 Session storage 或稳定 audit schema。

## Provider 自有状态

Provider adapter 可以在标准化消息上附加不透明 `modelState`，供后续请求延续
provider 原生会话或压缩。只有创建该状态的 adapter 才应解释它。其他 adapter 必须
回退到标准化 May 消息，而不能假设外部 wire format。

Provider HTTP API 和模型 capability 会独立于 May 变化。应用应解析 capability，
而不是从模型名猜测；未知能力必须仍被视为未知。

## 安全边界

权限审批不等于执行隔离。尤其是 `@may/coding-tools` 的 shell 会以 May 进程权限
运行。处理不可信指令或命令时，需要额外的 sandbox 或远程执行后端。

配置与 Session 文件可能含有敏感 prompt、工具输入/输出和 provider 数据；内置本地
store 不提供加密。

## 支持的运行时

当前 package 声明要求 Node.js 20 或更高版本。仓库开发需要 Node.js 22 或更高版本，
与 pnpm 11 工具链保持一致；推荐 Node.js 24，并在根目录 `.node-version` 中记录。
根目录 `package.json` 的 `engines.node` 声明开发最低版本；各 package 的运行时要求
保持不变。提高开发最低版本并不代表已验证所有声明的运行时和操作系统的兼容性。

仓库使用 pnpm 与 TypeScript project references。真实联网的 provider 集成测试需要
显式开启；常规测试离线运行。

## 稳定发布前

在声明 `1.0.0` 之前，项目应明确版本化并记录：

1. 导出的 TypeScript 契约；
2. 持久化 Session 和 Catalog 的迁移方式；
3. 持久化 presentation kind；
4. 事件演进规则；
5. 支持的 Node.js 和 provider adapter 版本；
6. tracing span/attribute 演进与 exporter 兼容方式；
7. 弃用与发布说明策略。

## 每次 Run 的动态工具目录

`MayOptions.toolSource`（也由 `AgentApplication`、`defineAgent()` 和
`MaybeCodeApplication` 透传）是可信宿主提供的同步 `() => Iterable<Tool>`。
它在静态 `tools` 之外追加工具，每次 `run()` 或 `continue()` 启动时仅调用一次，
而不是每个模型 step 调用。重名在 Context 修改前失败。远程发现/刷新应在 Core
之外完成，再通过回调发布最新内存快照。

`ToolRegistry.snapshot()` 创建冻结的 Tool 外观对象，并深拷贝、冻结 schema。
同一 Run 的模型定义、调度、解析、权限和执行使用同一份快照；模型收到独立的
schema 副本。目录更新仅影响下一次 Run。普通 registry 查询/`clone()` 仍保留
原始 Tool 身份，但 executor 收到的是 Run 外观对象：宿主元数据应放在 Tool
字段上，而不应只依赖对象身份 WeakMap。捕获的回调保持原始 `this`；这不是沙箱，
也不会深拷贝任意闭包状态。Schema 值必须支持 structured clone。

`Tool.permissionVersion` 是可选的宿主授权身份，不进入模型定义。Session grant
现在同时绑定策略 `grantKey`、规范化的名称、描述、输入 schema 和此版本。
定义或宿主身份变化，即使 grantKey 不变也需要重新批准；仅 schema 属性顺序
变化不会失效。`revokeSessionGrant(key)` 撤销该 key 下全部版本，显式 deny 始终
优先。宿主适配器应将其他影响执行的字段以及端点/账户身份包含在版本中。

现代 MRTR 表单/URL elicitation 通过 `McpInteractionBroker` 显式启用，交互式
MaybeCode CLI 默认开启。已实现 owner 作用域、整个流程的等待预算、用户答案校验和
续接前身份检查；旧交互使用显式隔离、单操作的连接，不猜测归属。
已实现显式启用的 Roots/Sampling 和现代 Tasks 及隔离 Apps Host；独立 server 导出也已实现，均需单独显式启用。Core 的可选 `toolScope` 标签保持
协议无关。参阅 [MCP](../guides/mcp.md)。

独立的经认证工具/资源/提示模板导出使用 `@may/mcp/server`，参阅
[server 编写](../guides/mcp-server.md)；不会自动开启监听或导出 Session。
