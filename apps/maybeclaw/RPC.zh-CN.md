# 外部 Agent RPC 适配器

MaybeClaw 导出 `@may/maybeclaw/rpc`。Agent 配置使用 `adapter: "module"`、`module: "@may/maybeclaw/rpc"`，通过 `options` 指定 stdio 或 socket 连接。模块导出 `createAdapter`。

```json
{
  "id": "external",
  "adapter": "module",
  "module": "@may/maybeclaw/rpc",
  "options": {
    "transport": "stdio",
    "command": "node",
    "args": ["external-agent.mjs"],
    "cwd": "agent-directory",
    "timeoutMs": 30000,
    "executionTimeoutMs": 0
  }
}
```

stdio 直接启动配置的可执行文件，使用 `shell: false`，Windows 进程窗口保持隐藏。`env` 可以提供环境变量。可执行文件的 stdout 专门传输 RPC，诊断信息写入 stderr。关闭适配器会终止其拥有的子进程。取消某个对话通过 RPC 请求完成，共享进程继续运行。

socket 配置支持 `{ "transport": "socket", "path": "socket-or-Windows-pipe" }` 或 `{ "transport": "socket", "host": "127.0.0.1", "port": 12345 }`。socket 连接只管理自身连接，关闭适配器不会终止远程进程。socket 应限制为可信主机访问，或者通过已经认证的保护通道使用；当前传输不附加网络认证或加密。

`timeoutMs` 限制连接建立和管理请求。`executionTimeoutMs: 0` 允许长时间执行。请求超时或者连接中断会产生 `RpcOutcomeUnknownError`，包含 `method`、`requestId` 和 `outcome: "unknown"`。查询操作会重新连接已经中断的传输，重新握手并确认能力保持一致，随后使用原请求 ID 查询结果。适配器不会自动重新提交结果未知的操作。

## 协议

连接使用 `vscode-jsonrpc` 的 stream reader 和 writer，以及它们提供的标准 Content-Length 消息格式。双方均可以发送 JSON-RPC 请求。消息格式由现有库处理。

首个请求为 `gateway/initialize`，参数为 `{ protocolVersion: 1, agentId }`。响应格式：

```json
{
  "protocolVersion": 1,
  "capabilities": {
    "cancel": true,
    "steer": false,
    "resume": true,
    "delete": true,
    "approvals": false,
    "collaboration": false,
    "media": []
  },
  "commands": ["status"]
}
```

只声明已经支持的能力。`commands` 列出允许 Gateway 转发的 Agent 命令。`new` 和 `resume` 由对话管理流程处理。

`media` 支持 `image`、`audio`、`file` 和 `video`。视频使用独立能力声明，输入采用文件 ContentPart 并保留原始 `video/*` MIME 类型。外部 Agent 确认能够处理对应内容后再声明支持。

| 方法 | 参数 | 结果 |
| --- | --- | --- |
| `conversation/create` | `requestId` | `{ conversationId }` |
| `conversation/inspectCreation` | `requestId` | `{ status: "not-started" }`、`{ status: "ready", conversationId }` 或 `{ status: "unknown" }` |
| `conversation/execute` | `conversationId`、`inputId`、`input`、`tools` | `{ text, runId?, yielded?, content? }` |
| `conversation/inspect` | `conversationId`、`inputId` | `{ status, text?, detail?, content?, runId? }` |
| `conversation/cancel` | `conversationId` | 取消完成后返回 `{ cancelled: true }` |
| `conversation/steer` | `conversationId`、`inputId`、`text` | `{ status }` |
| `conversation/steeringInputs` | `conversationId` | `[{ inputId, text, status }]` |
| `conversation/resolveApproval` | `conversationId`、`requestId`、`decision` | `{ resolved: boolean }` |
| `conversation/release` | `conversationId` | `{ released: true }` |
| `conversation/delete` | `conversationId` | `{ deleted: true }` |
| `conversation/command` | `conversationId`、`name`、`args` | `{ text }` |

`input` 使用 May `UserMessage`。支持协作时，`tools` 提供当前执行已经获得授权的协作工具名称、说明和输入 schema。执行状态包括 `not-started`、`queued`、`running`、`waiting`、`cancelling`、`completed`、`failed`、`cancelled` 和 `recovery-required`。

创建请求和执行请求的 ID 必须持久保存。重复使用同一个 ID 时必须指向同一操作，同一个 ID 对应的输入发生变化时需要报错。释放资源保留对话历史；删除操作清理专属于该会话的 Agent 对话。每个对话同一时间只允许一个执行。

声明 `steer: true` 时，需要同时支持两个补充信息方法。每条输入持久记录状态：等待 Step 边界时为 `pending`，已经包含在执行输入中时为 `delivered`，当前执行正常结束但尚未接收时为 `idle`，明确中断后为 `cancelled`。Gateway 在执行结束以及服务重启后查询此列表。`idle` 输入使用原 `inputId` 执行，随后变为 `delivered`。`conversation/steeringInputs` 与其他查询方法一样，在连接中断后重新连接并核对能力。

## Agent 回调

每个回调均包含 `conversationId` 和 `inputId`，标明对应的当前执行：

- `gateway/event` 通知：`{ conversationId, inputId, event }`，其中 `event` 为 May `AgentApplicationEvent`。
- `gateway/shouldYield` 请求：`{ conversationId, inputId }`，返回布尔值。在 Step 边界检查。
- `gateway/tool` 请求：`{ conversationId, inputId, name, callId, step, input }`，返回对应协作工具的执行结果。需要声明协作能力，且工具必须存在于当前执行提供的列表中。相同 `callId` 对应的输入发生变化时需要报错。
- 工具报告进度时，Gateway 发送 `gateway/toolProgress` 通知：`{ conversationId, inputId, callId, update }`。

外部 Agent 管理自己的模型、普通工具、工具审批执行、上下文和历史。Gateway 检查用户的会话权限后转发审批响应。

工作区通过 pnpm 应用 `patches/vscode-jsonrpc@9.0.2.patch`。传输写入失败时，原 RPC 请求通过 Promise 拒绝返回一次错误。Gateway 将请求结果记为未知，并要求查询状态；依赖内部异步 Promise executor 的重复拒绝不能终止服务。`test/gateway-membership.test.mjs` 使用真实子进程终止场景验证这一行为。

## 可执行示例

`examples/rpc-file-agent.mjs` 是独立运行的文件操作服务，支持持久对话。它可以计算指定工作目录中文件的 SHA-256，或者等待文件出现，支持 stdio 和 socket。示例执行确定性的文件操作，不调用语言模型。

启动命令为 `node examples/rpc-file-agent.mjs --directory <state-directory> --workspace <workspace-directory>`。附加 `--socket <path>` 可以接受多个 socket 连接。执行输入的正文使用 JSON，例如 `{ "operation": "sha256", "path": "README.md" }` 或 `{ "operation": "waitForFile", "path": "result.txt" }`。

附加 `--no-cancel` 可以关闭该服务的取消能力。握手返回 `cancel: false`，取消请求会被拒绝，已经接收的文件操作继续执行。Gateway 仍会撤销退出成员的访问权限，并明确通知无法停止的执行。

`test/gateway-rpc.test.mjs` 启动真实子进程，检查文件 hash 和持久保存的请求状态，验证取消某个对话时其他对话仍可使用，并验证执行超时后重新连接 socket 服务查询原请求。
