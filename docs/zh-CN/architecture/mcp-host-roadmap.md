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
- [x] **Host 交互**：Elicitation 表单/URL、MRTR、workspace/session/run/request
  作用域路由、取消/过期/预算、headless controller 与 UI、显式旧 Roots/Sampling
  兼容；不死锁，不主动泄露上下文或提供未授权模型访问。
  - [x] 现代 MRTR 表单/URL broker、Core Host 作用域、controller 和两个 UI、
    有界等待/取消、Session 缓存隔离及认证校验。
  - [x] 显式 Roots/Sampling 及旧协议请求归属兼容。
- [x] **长任务与扩展**：任务句柄、get/update/cancel、持久 ownership 和重启恢复、
  区分本地停止等待与远端取消；可选的隔离 MCP Apps UI，以及终端明确的不支持行为。
  - [x] 存储基础：绑定归属的加密任务 journal、预写身份占用、输入去重/预算、取消意图。
    证据：`task-journal.test.mjs`；参阅 [任务持久化](../guides/mcp-tasks.md)。
  - [x] 支持任务的 wire 调用、句柄 controller/UI、polling/update/cancel，以及客户端/
    服务端进程重启后恢复，不重放创建。证据：`task-runtime.test.mjs` 和 MaybeCode
    任务输入/附件集成。显式启用 2026-07-28 扩展，支持轮询，尚无任务订阅通知。
  - [x] 可选隔离 Apps Host 与明确的终端 fallback。证据：`apps.test.mjs`，含真实
    Chromium sandbox smoke；参阅 [Apps](../guides/mcp-apps.md)。
- [x] **独立 MCP Server**：显式选择导出 May 工具/资源/提示模板，认证调用者并隔离
  workspace，经过正常权限/执行路径，不批量暴露本机工具或 Session 历史。证据：
  `server.test.mjs`（真实 HTTP 及现代/旧版 stdio）、必需公开投影、审批期间撤销；
  参阅 [server 导出](../guides/mcp-server.md)。
- [x] **完成审计**：各阶段具备聚焦行为验证和产品集成证据；更新全部维护语言，检查
  安全边界、实际支持版本/扩展，并提交已完成改动。

OAuth 完成不代表目录、Host 交互或扩展已完成。所有条目都有直接证据前，不得将整体
迁移标记完成。

能力阶段证据：`catalog.test.mjs`、`capabilities.test.mjs`、OAuth 缓存隔离测试、
Core registry/permissions 测试及 MaybeCode 配置/MCP 命令测试。工具/资源/模板/
prompt/补全、有界附件、缓存失效及新旧协议订阅已实现。现代 Host 交互证据：
`interactions.test.mjs`、OAuth 身份变更时续接测试、Core 作用域快照测试，以及
MaybeCode 终端/准备阶段集成测试。Host 兼容证据：`host-services.test.mjs`（经审阅
的 Roots/Sampling、模型/工具历史桥接、预算/取消/错误隐藏、并发隔离的旧 stdio/HTTP
操作、提前完成及进程/session 清理），以及 `mcp-capabilities.test.mjs` 中的
MaybeCode 配置 provider/UI 集成。编辑器 schema 的 HTTP/OAuth/Host 选项也经过
正反例校验 smoke。旧版通道按操作创建且不复用，不猜测无归属请求的 owner。
规划内适配阶段均有实现和验证证据，但不等于实现所有可选 MCP 扩展。

## 完成审计 — 2026-09-06

| 边界 | 审计结论 |
| --- | --- |
| 架构 | Core/application 源码和 manifest 不依赖 MCP。客户端工具保留正常 executor/scheduler 路径，server 导出显式接收 Host 执行器。 |
| 版本 | 客户端现代核心 `2026-07-28` 及显式旧版兼容；Tasks 扩展 `2026-07-28`；Apps UI `2026-01-26`；client/server SDK 2.0.0。不伪称兼容 2025 实验 Tasks。 |
| 归属 | 按 Run 快照、凭据/目录绑定续接、持久 workspace/Session 任务归属、单 owner App 通道、逐请求认证的 server principal。不采用正文 owner，不任意导出 Session 历史。 |
| 副作用 | 未知结果不自动重放；等待与远端取消分开；任务附件、App/数据分享均显式进行；导出结果要求公开投影。 |
| UI 隔离 | 独立 origin 代理 + opaque 内层 iframe、严格 CSP、校验消息来源，不自动改写 Context/打开链接；终端不执行 HTML。回调忽略 signal 不会阻止中止本地 App 等待。 |
| 打包 | 根客户端 API、独立 `@may/mcp/server`、浏览器专用 `@may/mcp/apps-browser` 均从仓库外安装的 tarball 成功导入。 |
| 验证 | `pnpm test`：**390 通过，零失败/跳过**，含显式运行的真实 Chromium smoke。`pnpm build`、`pnpm docs:check`（32 对双语文档）、安装包 smoke、`git diff --check` 通过。未运行付费真实 provider 或第三方 server 认证。 |

以下是各能力指南中明确维护的限制，不是隐藏的未完成工作：Tasks 显式轮询，不实现
可选任务订阅通知。Apps 需要自定义图形 Host、自包含内容和显式用户操作，不授予外部
网络/设备权限，也不提供 `ui/message` 或 Context 改写。独立 Server 只导出即时白名单
工具/资源/提示模板，不自动具备所有客户端功能，也不提供 OAuth issuer。自动重连/
重放和已移除的 HTTP+SSE 保持禁用。原生 keyring 集成证据来自前阶段显式 Windows
smoke；常规测试注入 keyring 存储，不修改真实凭据。生产 verifier、文件系统 sandbox
和 UI 通道认证仍由嵌入应用负责。
