# ADR 0004：Agent definition 与工具 registry 是可复用组合对象

[English](../../../en/architecture/decisions/0004-agent-definitions-and-tool-registries.md) | **简体中文**

- **状态：** 已接受
- **日期：** 2026-09-02

## 背景

May 已经把 Core 执行循环与 Session/application 生命周期分开，但产品仍会重复两种
组合模式：

1. 收集工具数组、检查名称冲突，并派生按名称查询和面向模型的视图；
2. 维护一个 factory，却把可复用行为/策略与单个 Session 的 store、身份和 metadata
   混在一起。

数组仍是有用的交换类型，也必须继续支持直接调用 `AgentApplication.open()`。但是，
它们无法明确表达生命周期边界或无重复组合规则。进程级全局 registry 会引入隐藏的
可变状态，使测试和多个产品相互干扰。

## 决策

Core 提供普通实例形式的 `ToolRegistry`，并实现 `Iterable<Tool>`。它校验工具、保留
插入顺序、以 `DuplicateToolNameError` 拒绝有歧义的名字，并支持原子批量注册、查询、
快照、面向模型的定义、clone、迭代与组合。它不是 singleton 或 service locator。
Registry 保留原始 Tool 身份，同时记录 readonly descriptor 的值/引用；若注册后替换
名称、描述、schema 引用、parser 或 executor，后续访问会以 `TypeError` 拒绝不一致。
Schema 本身不会被深度冻结。

`May` 接受任何 `Iterable<Tool>`，并在构造 runtime 时快照其成员。之后修改源集合不会
改变活动 runtime。

Application package 提供 `AgentDefinition` 和 `defineAgent()`。Definition 捕获可复用
行为与策略，包括 Model、指令、工具、permission policy、Context 策略和 application
option；它排除 Session-bound 的存储、身份、resume 和 metadata。这些输入传给：

```ts
definition.open({
  store,
  sessionId,
  resume,
  metadata,
  contextMetadata,
});
```

Definition 在创建时快照 iterable 的成员。每次 `open()` 都创建独立的
`AgentApplication` 和 Session 生命周期。快照不会深克隆 Tool 对象或其他协作者：
当一个 definition 捕获有状态 Model、Context factory、tool executor、tool scheduler、
compaction strategy 或 policy closure 时，它们仍由调用方拥有并被共享。

## 后果

- 产品可以组合各 feature 拥有的工具组，而无需全局状态或手写重名检查。
- Definition 让行为与 Session 的边界变得明确，并可在 workspace application factory
  中复用。
- Array、Set、generator 和自定义 registry 都仍可通过 iterable 契约作为工具来源。
- 现有调用方可以继续直接使用 `AgentApplication.open()`。
- 构造之后的 registry 变化不会悄悄改变 definition 或活动 runtime。
- Tool identity 可用于 `WeakMap` metadata，但调用方必须保持已注册 descriptor 稳定。
- 打开多个 application 不会自动让已捕获的协作者具备并发安全；产品必须选择或创建
  符合所需 ownership 模型的协作者。
- Agent definition 是进程内组合对象，不是持久化 manifest、发现 registry、依赖注入
  container 或 Session snapshot。
