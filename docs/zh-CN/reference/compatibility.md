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

当前 package 声明要求 Node.js 20 或更高版本。仓库开发使用 pnpm 与 TypeScript
project references。真实联网的 provider 集成测试需要显式开启；常规测试离线运行。

## 稳定发布前

在声明 `1.0.0` 之前，项目应明确版本化并记录：

1. 导出的 TypeScript 契约；
2. 持久化 Session 和 Catalog 的迁移方式；
3. 持久化 presentation kind；
4. 事件演进规则；
5. 支持的 Node.js 和 provider adapter 版本；
6. 弃用与发布说明策略。
