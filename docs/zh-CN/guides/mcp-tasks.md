# 管理 MCP 长任务

[English](../../en/guides/mcp-tasks.md) | **简体中文**

本文用于启用和管理超出即时工具响应时间的远程任务。需要可信且支持 Tasks 的
服务端、安全任务日志，以及能够提供工作区和 Session 归属的应用。基础连接
参阅[MCP 指南](mcp.md)。

## 支持范围

`@may/mcp` 和 MaybeCode 已支持显式启用的任务创建、状态检查、经审阅输入、等待、
协作式取消及绑定归属的恢复，适用于现代 stdio 和 Streamable HTTP。支持扩展
`io.modelcontextprotocol/tasks`，版本 `2026-07-28`：使用扁平任务句柄以及 `tasks/get`、
`tasks/update`、`tasks/cancel`。不兼容的 2025 实验版 `tasks/list`/`tasks/result`
协议不在支持范围。尚未实现可选的任务订阅通知；支持明确轮询。
[独立服务端导出](mcp-server.md)支持即时工具结果。

## 启用 Tasks

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
      "tasks": true
    }
  } } }
}
```

MaybeCode 默认使用 `<dataDirectory>/mcp-tasks` 下由系统钥匙串加密的独立任务日志。
自定义宿主启用 Tasks 时，需要向 `openMcpClientPool` 提供 `taskJournal`：

```ts
import { KeyringMcpCredentialStore, McpTaskJournal } from "@may/mcp";
const taskJournal = new McpTaskJournal(new KeyringMcpCredentialStore("./data/mcp-tasks"));
```

也可注入安全的 `McpCredentialStore`。`InMemoryMcpCredentialStore` 退出后不保留
恢复信息。需要相互隔离的所有 Session 应共享一个存储；独立存储无法实现跨存储归属
约束。

自定义宿主将 `taskJournal` 与 `servers` 放入同一组 `openMcpClientPool` 参数。
上述相对路径基于进程工作目录，需要可用的系统钥匙串。保留该目录用于重启恢复。
服务端需要 Roots 或 Sampling 时，单独启用，并提供能够并发处理事件的交互界面。

## 检查和完成任务

1. 通过通常的权限界面批准能够创建任务的工具。返回延迟结果时，保留本地任务句柄。
2. 使用 `/mcp tasks` 查找当前 Session 的句柄，执行
   `/mcp task-get <server> <local-id>` 检查远程状态。
3. 任务运行期间使用 `task-wait`。需要输入时使用 `task-update`，审阅表单、URL
   或兼容能力请求。
4. 完成后使用 `task-get` 预览。需要新 Run 读取结果时，明确执行 `task-attach`。
5. 需要停止远程工作时，明确执行 `task-cancel`，随后检查状态。需要移除本地记录
   时执行 `task-forget`。

## 用户控制与 Context

任务创建仍是经过 Core 正常权限/执行链路的 MCP 工具调用。异步结果只向模型返回
**本地任务句柄**。管理 API 由宿主明确调用，不会自动作为模型
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
之外响应交互事件，使等待输入的操作能够取得答案，参阅[宿主交互](mcp.md)。

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

每个 Session 最多保留 64 条记录、512 KiB。创建阶段 MRTR 用量计入任务整个生命
周期的持久预算：最多 32 次宿主输入尝试（含重试）、四次 Sampling 预留、合计 16,384 个
预留输出 token，单次最多 4,096。经批准的 sampling 用量先持久化再调用 provider；
取消、不披露输出及重试都不会退还预算。

只持久化路由元数据、时间戳、状态、取消意图和散列 claim，不存储参数、状态消息、
输入载荷、答案、错误或结果。远端 id 和 owner 标签在 keyring vault 内加密。跨
Session 索引为每个端点身份保留最多 1,024 条散列远端 id 记录，forget 后仍保留。
先占用再绑定 Session，因此部分写入仍保留限制访问的记录。索引满后需要审计未完成
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

图形集成与终端文本显示参阅[隔离 Apps Host](mcp-apps.md)。

## 验证任务恢复

使用真实任务端点，确认重启保留本地句柄、等待在需要输入或终态时结束、本地取消
不改变远端状态，以及结果附加需要明确操作。仓库的本地 HTTP 与进程集成测试通过
仓库根目录的 `pnpm --filter @may/mcp test` 执行。第三方服务需要单独验证账户与
兼容性。
