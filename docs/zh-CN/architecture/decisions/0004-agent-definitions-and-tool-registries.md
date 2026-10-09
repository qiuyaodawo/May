# ADR 0004：Agent definition 与工具 Registry 提供可复用组合

[English](../../../en/architecture/decisions/0004-agent-definitions-and-tool-registries.md) | **简体中文**

- **状态：** 已接受
- **日期：** 2026-09-02

## 背景

Core 执行循环与 Session/application 生命周期具有独立职责。产品仍需要组合工具、
检查重名、生成查询与模型视图，以及复用行为和策略。组合对象明确这些规则与
多个产品在同一进程内的所有权。数组仍可作为交换类型，也支持直接调用
`AgentApplication.open()`。

## 决策

Core 的 `ToolRegistry` 是调用方拥有的普通实例，实现 `Iterable<Tool>`。它校验
工具、保留插入顺序、以 `DuplicateToolNameError` 拒绝重名，支持原子批量注册、
查询、快照、模型定义、克隆、迭代与组合。注册保留原始 Tool 身份，并记录描述字段
的值和引用；替换这些字段会在后续访问时触发校验错误。

`May` 接受 `Iterable<Tool>`，在构造时保存静态工具成员。每次 Run 的 `snapshot()`
创建冻结的 Tool 外观对象与 schema 副本。动态 `toolSource` 在 Run 开始时获取。
回调身份与更新行为见[兼容性参考](../../reference/compatibility.md#每次-run-的动态工具目录)。

Application 包提供 `AgentDefinition` 与 `defineAgent()`。Definition 捕获 Model、
指令、Tool、权限策略、Tool executor、Tool scheduler、Context 策略和应用选项。
Session 存储、身份、恢复选项与元数据由每次 `open()` 提供。完整应用示例见
[构建 Agent 指南](../../guides/building-an-agent.md)。

Definition 在创建时保存工具集合成员。每次 `open()` 创建独立的应用与 Session
生命周期。集合快照共享 Tool 对象及其他协作者；有状态 Model、Context factory、
executor、scheduler、压缩策略和权限策略闭包仍由调用方拥有。描述字段需要保持
稳定；Registry 检查值和引用，工具与原始 JSON Schema 由调用方管理。

## 后果

- 产品可以组合功能所属的工具组，并复用重名检查。
- Definition 明确行为与 Session 的边界，可以用于 workspace 应用工厂。
- Array、Set、generator 与自定义 Registry 可以作为 Iterable 工具来源。
- 调用方继续支持直接使用 `AgentApplication.open()`。
- 构造后修改源集合不会改变已保存的静态成员。
- 普通 Registry 组合保留 Tool 身份，Run 执行使用冻结外观对象；执行元数据放在
  Tool 字段中。
- 调用方需要为共享协作者提供合适的并发安全与生命周期管理。
- Agent definition 是进程内组合对象，持久化配置、发现机制与 Session 快照由
  对应功能分别管理。
