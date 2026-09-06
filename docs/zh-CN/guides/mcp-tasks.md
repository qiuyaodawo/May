# MCP 任务持久化

[English](../../en/guides/mcp-tasks.md) | **简体中文**

## 当前实现边界

`@may/mcp` 已提供下述任务帧解析器和持久归属 journal。**客户端池尚未声明 Tasks，
尚不能创建远端任务句柄、轮询、update、cancel，也未在 MaybeCode 提供任务命令。**
存储基础不等于端到端 Tasks 支持；运行时接入仍在[路线清单](../architecture/mcp-host-roadmap.md)
中保持未完成。

API 面向 [2026-07-28 Tasks 扩展](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks)，
标识为 `io.modelcontextprotocol/tasks`。该 wire 格式使用扁平任务句柄，以及
`tasks/get`、`tasks/update`、`tasks/cancel`，不是不兼容的 2025 实验版
`tasks/list`/`tasks/result` 生命周期。扩展最终须与核心协议能力分开协商。

## 存储 API

```ts
import { KeyringMcpCredentialStore, McpTaskJournal } from "@may/mcp";

// 使用独立 vault 目录，其加密主密钥保存在 OS keyring 中。
const journal = new McpTaskJournal(new KeyringMcpCredentialStore(taskVaultDirectory));
const records = await journal.list({ workspaceId, sessionId });
```

Journal 复用事务式 `McpCredentialStore` 端口，不复用 OAuth 记录。自定义宿主可
注入安全存储；`InMemoryMcpCredentialStore` 则有意不提供进程退出后的恢复。
需要相互隔离任务归属的 Session 必须共用一个 store；不同 store 之间无法校验归属。

- `begin(owner, binding)` 在任何可能产生任务的调用**之前**写入宿主生成的本地
  句柄，写入失败必须阻止发送。调用者提供可信 workspace/Session/Run/tool-call
  owner、协议版本、server/tool 名、opaque 端点/认证身份以及完整工具定义 hash。
  端点身份必须跨重启稳定，代表真实目标和认证 grant（而不只是配置别名），并在
  身份变化时改变。Journal 不自行发现或认证这些身份。
- `observe(..., raw, "created" | "state")` 校验并绑定元数据。后续轮询需保持
  remote id/创建时间一致，更新时间不倒退，终态不能变化。state 轮询不能绑定此前
  未知的句柄。跨 Session 归属索引阻止复用 remote id，即使已忘记本地历史也一样。
  最终工具输出仍须由宿主依据原定义校验后才能使用。
- `get` 要求当前 binding 和 Session；`list` 只读取本地 Session 分区，二者均不
  请求远端。`uncertain` 记录初次调用结果未知，但不允许重放。恢复后的 `starting`
  也可能来自崩溃窗口，不能据此认定可以再次发送。
- `claimInput` 在 UI/模型工作前原子占用唯一的 key/内容指纹；并发或重复轮询不能
  二次领取，同 key 内容变化会安全失败。调用者只能领取已校验的当前任务响应中的
  key。`reserveSampling` 在调用 provider 前持久预留批准的用量，每个 claim 一次。
  `markInput("submitted")` 在 `tasks/update` 之前写入，ack 单独记录。不存储答案
  或模型输出。中断的 claim 在重启后继续占用，不得静默再次提问、计费或提交。
- `cancelIntent("requested" | "acknowledged")` 独立于任务状态记录远端取消意图。
  ack 不是已经取消的证明，后续仍可能成功完成。停止本地等待不需要写远端取消意图。
  `forget` 只删除本地 Session 记录，不取消或删除远端工作。

Journal 不调用模型、不满足 Host 请求、不发 RPC、不轮询/重试、不附加 Context，
也不授予工具权限。接入的运行时必须落实这些边界，并在每次网络或 Host 服务动作前
检查当前认证/目录状态。

## 上限与恢复

每个 Session 最多保留 64 条记录 / 512 KiB；每任务最多 32 个唯一 Host 输入 claim、
四次 sampling 预留、16,384 个预留输出 token，每次最多 4,096。归属索引为每个
端点身份最多保留 1,024 个 remote-id hash tombstone。满时安全失败；显式维护
store 时必须先审计未完成句柄，才能删除该身份的 tombstone。本地 forget 不会
自动删除它们。

只持久化路由元数据、时间戳、状态和 claim hash，不保留参数、状态说明、输入请求、
答案、错误或最终结果。Keyring vault 加密 remote id 和 owner 标签。归属预留先于
Session 更新，因此部分写入只会留下限制性 tombstone，不会让其他 Session 接管 id。
正常重新打开无需网络操作即可恢复元数据。数据损坏或 keyring 不可用时安全失败，
不静默迁移未知格式。与凭据 vault 一样，进程崩溃可能留下 `.lock` 文件；先确认
记录的 PID 已退出，再删除那个确切的陈旧锁。不得重置 vault 来把未知任务结果变成
看似可以安全重放的操作。

`parseMcpTask` 校验扩展 discriminator、扁平 id、状态、时间戳、TTL/轮询提示及
有界的状态特定 payload 结构。不校验最终工具 schema 或执行输入请求，也不在存储
中隐藏 TTL/轮询策略。证据：`packages/mcp/test/task-journal.test.mjs` 覆盖内存及
加密重开、owner/认证/工具定义不匹配、跨 Session 重复 id、部分写入、输入去重/预算、
取消竞争、大小限制及篡改拒绝。这些是存储/解析器检查，不是远端服务一致性测试。
