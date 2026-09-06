# MCP 长任务

[English](../../en/guides/mcp-tasks.md) | **简体中文**

## 支持范围

`@may/mcp` 和 MaybeCode 已支持显式启用的任务创建、状态检查、经审阅输入、等待、
协作式取消及绑定归属的恢复，适用于现代 stdio 和 Streamable HTTP。目标为
[2026-07-28 Tasks 扩展](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks)，
标识 `io.modelcontextprotocol/tasks`：使用扁平任务句柄以及 `tasks/get`、
`tasks/update`、`tasks/cancel`。不兼容的 2025 实验版 `tasks/list`/`tasks/result`
协议不在支持范围。尚未实现可选的任务订阅通知；支持显式轮询。server 导出
仍是独立的[路线阶段](../architecture/mcp-host-roadmap.md)。

在端点设置 `tasks: true`（默认 `false`）。连接必须同时协商核心版本 `2026-07-28`
和服务端 Tasks 扩展；必需端点不满足时启动失败。stdio 默认 legacy，因此现代任务
服务端还需 `protocolMode: "auto"`。扩展只在启用任务的 `tools/call` 和任务管理请求
中声明，不做全局声明，也不附加到资源/提示模板请求。仍可返回即时工具结果。

```json
{
  "apps": { "maybecode": { "mcpServers": {
    "jobs": {
      "transport": "streamable-http",
      "url": "https://jobs.example.com/mcp",
      "tasks": true,
      "host": { "sampling": true }
    }
  } } }
}
```

MaybeCode 默认使用 `<dataDirectory>/mcp-tasks` 下独立的 OS keyring 加密 journal。
自定义 Host 启用 Tasks 时必须给 `openMcpClientPool` 传入 `taskJournal`：

```ts
import { KeyringMcpCredentialStore, McpTaskJournal } from "@may/mcp";
const taskJournal = new McpTaskJournal(new KeyringMcpCredentialStore(taskVaultDirectory));
```

也可注入安全的 `McpCredentialStore`。`InMemoryMcpCredentialStore` 退出后不保留
恢复信息。需要相互隔离的所有 Session 应共享一个存储；独立存储无法实现跨存储归属
约束。

## 用户控制与 Context

任务创建仍是经过 Core 正常权限/执行链路的 MCP 工具调用。异步结果只向模型返回
**本地任务句柄**，不是重复调用的许可。管理 API 是显式 Host 控制，不会自动作为模型
工具暴露。两个终端 UI 共用以下命令：

| 命令 | 效果 |
| --- | --- |
| `/mcp tasks [server]` | 查看当前 Session 本地元数据，不联网 |
| `/mcp task-get server local-id` | 获取并预览当前状态 |
| `/mcp task-wait server local-id` | 工作中轮询，遇待输入或终态即返回 |
| `/mcp task-update server local-id` | 审阅并处理尚未占用的输入 |
| `/mcp task-retry-input server local-id` | 显式重新审阅已放弃/过期且未确认的输入 |
| `/mcp task-cancel server local-id` | 请求协作式远端取消 |
| `/mcp task-forget server local-id` | 仅删除本地记录 |
| `/mcp task-attach server local-id [question]` | 显式将完成结果附加到新 Run |

预览、轮询和通知不会把结果追加进 Context。附件采用有界且带来源标记的用户内容，
保留多模态/结构化结果，并校验原始工具输出 schema（`isError` 结果无需满足成功
schema）。服务端内容视为不可信数据，终端输出经过净化。任务表单答案及 sampling
输入/输出审阅不会写入 Session 历史。

池 API 包括 `listTasks(owner)`、`getTask`、`updateTask`、`waitTask`、`cancelTask`
（传入 server id、本地 id 和可信 owner 选项），以及
`forgetTask(serverId, localId, owner)`。`mcpTaskToUserMessage` 显式转换完成结果。
MaybeCode 提供对应的 `*McpTask` controller 方法，以及 `listMcpTasks`、
`submitMcpTask`，自行填入当前 workspace/Session 并固定状态转换。UI 必须在此队列
之外响应交互事件，与 [Host 交互](mcp.md) 相同，避免审批死锁。

## 归属、输入与取消

发送可创建任务的调用**之前**必须成功预写本地记录。运行时绑定原始
workspace/Session/Run/tool-call owner、实际端点及认证身份、协议版本和完整工具
定义。后续每个动作都校验当前绑定和目录。凭据、目标或工具定义变化即拒绝；相同配置
别名不代表授权。正常重启使用稳定身份，不复用旧连接请求 id。已收到的远端句柄会在
Run 刚取消时仍被持久化。初始结果不确定时保留 `starting`/`uncertain`，绝不自动重放。

`task-update` 复用已有表单/URL/Roots/Sampling 审阅服务。Roots/Sampling 仍需显式
Host 配置和交互消费者。重启后保留原始 owner；任务输入不能读取 Session 历史或调用
本地工具。每个输入 key/内容指纹先占用再展示 UI，提交状态先于 RPC 写入，ack 另记。
重复轮询不会再次提问/计费；旧 key 换内容会拒绝。答案本身不持久化。

普通 update 不重试已占用输入。`task-retry-input`（API 选项
`retryAbandonedInputs: true`）通过原 claim 的原子校验，只为已放弃或已过期且未确认
的输入发起新审阅。它不重置预算、不重放工具创建，也不重发存储的答案。已确认输入
不能重试。丢失 update ack 可能意味着服务端已接受输入：先轮询，理解不确定性后再
决定是否重试。claim 使用有界操作截止时间；无截止时间的旧记录不被视为过期。

等待默认五分钟，`waitTask` 可配置至最多一天，单次网络请求仍有超时。遵循服务端
轮询间隔（下限 250 ms，默认一秒），TTL 到期在本地拒绝。Ctrl+C、等待超时、连接
关闭或应用退出只停止**本地**工作，不发送远端取消。`task-cancel` 记录意图和 ack，
不直接写入终态：远端完成可能赢得竞态。forget 不取消或删除远端工作。重启后不会
自动后台轮询、调用模型、重连/重放或附加 Context。

## 存储、预算与验证

每个 Session 最多保留 64 条记录 / 512 KiB。创建阶段 MRTR 用量计入任务的持久生命
周期预算：最多 32 次 Host 输入尝试（含重试）、四次 sampling 预留、合计 16,384 个
预留输出 token，单次最多 4,096。经批准的 sampling 用量先持久化再调用 provider；
取消、不披露输出及重试都不会退还预算。

只持久化路由元数据、时间戳、状态、取消意图和散列 claim，不存储参数、状态消息、
输入载荷、答案、错误或结果。远端 id 和 owner 标签在 keyring vault 内加密。跨
Session 索引为每个端点身份保留最多 1,024 条散列远端 id 墓碑，forget 后仍保留。
先占用再绑定 Session，因此部分写入只会留下更严格的墓碑。索引满后需要审计未完成
句柄再显式维护，不会自动淘汰。

`McpTaskJournal` 提供 `begin`、`initialUsage`、`observe`、`get`/`list`、
`uncertain`、`claimInput`、`reserveSampling`、`markInput`、`abandonInput`、
`cancelIntent`、`forget`，自身不发送 RPC 或授予权限。`parseMcpTask` 校验有界原生
帧；运行时进一步校验工具结果内容/schema。数据损坏或 keyring 不可用时拒绝操作。
若崩溃遗留 vault `.lock`，先验证其中 PID 已退出，再删除那个明确的陈旧锁；绝不能
重置 vault 来将未知结果解释为可安全重放。

扩展通道独占字符串 RPC id，不访问 SDK 私有请求表，不伪造核心工具结果绕过解码。
HTTP 管理请求携带 `Mcp-Name` 任务路由；工具请求保留支持的 `x-mcp-header` 路由。
诊断省略服务端 RPC 错误文本及输入载荷。证据：`task-journal.test.mjs`、
`task-runtime.test.mjs`（HTTP、真实 stdio 进程重启、审阅/重试、取消竞态、身份变化
及输出校验），以及 MaybeCode 的 `mcp-capabilities.test.mjs`（权限门控、终端输入、
显式附件）。这些聚焦 fixture 不等于对所有第三方服务端的完整符合性认证。

可选图形集成及终端 fallback 参阅[隔离 Apps Host](mcp-apps.md)。
