# MCP Host 适配路线与验收

[English](../../en/architecture/mcp-host-roadmap.md) | **简体中文**

目标是完成 MCP 设计中的全部剩余阶段，而不只是 HTTP 工具。本清单记录实现与证据；
未勾选项不会因为 SDK 提供对应方法就算已支持。Core 必须保持协议无关，ADR 0006
确立的工具执行与权限边界继续有效。

- [x] **传输基线**：stdio + Streamable HTTP、新版发现与旧版协商、取消/清理、
  安全诊断及 MaybeCode 配置。证据：`packages/mcp/test/mcp.test.mjs` 和
  MaybeCode 配置测试。
- [x] **原生 OAuth 与凭据存储**：PKCE/state/issuer 校验、公共预注册/CIMD/DCR、
  scope 同意、串行刷新及 issuer 隔离、退出/撤销、OS keyring 主密钥支持的加密
  vault，以及模型启动前的 CLI。证据：`packages/mcp/test/oauth.test.mjs`、
  MaybeCode 命令测试、显式运行的 Windows 原生 keyring smoke。参阅
  [认证指南](../guides/mcp-auth.md)。
- [x] **能力与动态目录**：工具、资源/模板、提示模板、补全、缓存/订阅、有界内容及
  附件适配；按 Run 固定的不可变工具快照、定义变化后的旧授权失效、端点刷新/重连，
  不重放结果不确定的有副作用操作。
- [ ] **Host 交互**：Elicitation 表单/URL、MRTR、workspace/session/run/request
  作用域路由、取消/过期/预算、headless controller 与 UI、显式旧 Roots/Sampling
  兼容；不死锁，不主动泄露上下文或提供未授权模型访问。
  - [x] 现代 MRTR 表单/URL broker、Core Host 作用域、controller 和两个 UI、
    有界等待/取消、Session 缓存隔离及认证校验。
  - [ ] 显式 Roots/Sampling 及旧协议请求归属兼容。
- [ ] **长任务与扩展**：任务句柄、get/update/cancel、持久 ownership 和重启恢复、
  区分本地停止等待与远端取消；可选的隔离 MCP Apps UI，以及终端明确的不支持行为。
- [ ] **独立 MCP Server**：显式选择导出 May 工具/资源/提示模板，认证调用者并隔离
  workspace，经过正常权限/执行路径，不批量暴露本机工具或 Session 历史。
- [ ] **完成审计**：各阶段具备聚焦行为验证和产品集成证据；更新全部维护语言，检查
  安全边界、实际支持版本/扩展，并提交已完成改动。

OAuth 完成不代表目录、Host 交互或扩展已完成。所有条目都有直接证据前，不得将整体
迁移标记完成。

能力阶段证据：`catalog.test.mjs`、`capabilities.test.mjs`、OAuth 缓存隔离测试、
Core registry/permissions 测试及 MaybeCode 配置/MCP 命令测试。工具/资源/模板/
prompt/补全、有界附件、缓存失效及新旧协议订阅已实现。现代 Host 交互证据：
`interactions.test.mjs`、OAuth 身份变更时续接测试、Core 作用域快照测试，以及
MaybeCode 终端/准备阶段集成测试。旧 push elicitation 当前直接拒绝，不猜测归属。
显式 Roots/Sampling 兼容、tasks/Apps、server 导出和最终审计仍未完成。
