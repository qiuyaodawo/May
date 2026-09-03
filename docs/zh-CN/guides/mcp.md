# MCP 工具

[English](../../en/guides/mcp.md) | **简体中文**

`@may/mcp` 使 May 应用可以使用 Model Context Protocol（MCP）服务器提供的工具，
同时不把协议和进程管理代码放进 Core。首个版本支持本地 stdio client 与 MCP tool
能力。

## 为什么使用独立 package

Core 已经知道如何描述、授权、调度、取消、执行和追踪一个 `Tool`，但不应该了解外部
工具如何发现或传输。因此 `@may/mcp` 依赖 Core，把远程 MCP tool 适配到既有 `Tool`
契约：

```text
MCP server process
  ^ stdio: initialize, tools/list, tools/call
  |
@may/mcp adapter -> Core Tool -> ToolRegistry
                                  |
模型工具调用 -> permission -> scheduler -> adapter -> MCP server
```

这个方向使 MCP 保持可选：只有本地工具的 Agent 不会引入 MCP runtime dependency；
MCP 工具则自动经过与其他 Core 工具相同的权限、调度、事件、取消、Session 和 tracing
路径。

## Package API

打开 client pool，组合它在启动时获得的工具快照，并在产品 ownership 边界关闭 pool：

```ts
import { defineAgent } from "@may/application";
import { ToolRegistry } from "@may/core";
import { openMcpClientPool } from "@may/mcp";

const mcp = await openMcpClientPool({
  servers: [{
    id: "workspace",
    command: "node",
    args: ["./mcp-server.mjs"],
    cwd: process.cwd(),
    env: { ACCESS_TOKEN: process.env.ACCESS_TOKEN! },
    required: false,
    requestTimeoutMs: 60_000,
  }],
  tracer,
});

const agent = defineAgent({
  model,
  tools: ToolRegistry.compose(localTools, mcp.tools),
  permissionPolicy,
  tracer,
});

const application = await agent.open({ store });
try {
  // 提交 Run
} finally {
  await application.close();
  await mcp.close();
}
```

打开时会对每个 server 执行 MCP 初始化握手和聚合的 `tools/list` 请求。Server 默认是
required：required server 失败时，已打开的 server 会先关闭，然后启动整体失败。配置
`required: false` 的 server 失败时只记录失败状态，其余 server 仍可继续启动。
`close()` 可重复调用；即使一个连接关闭失败，它仍会访问所有连接。stdio transport
启动的子进程也由 pool 负责终止。

`requestTimeoutMs` 设置单次请求的不活动超时；即使不断收到 progress，
`maxTotalTimeoutMs` 也可以限制总时长；`maxBufferSize` 限制单条协议消息。省略时使用
MCP SDK 默认值。

`pool.status()` 返回所有已配置 server 的即时视图，包括连接状态、已发现工具名、最新
诊断和近期 stderr。`pool.events` 发布 connected、failed 与 disconnected 生命周期
事件，产品无需解析日志即可观察连接变化。

Stdio stderr 会被 pipe，而不是直接继承到终端。每个 server 只保留经净化的末尾片段，
大小由 `stderrMaxBytes` 限制（默认 16 KiB），因此高噪声子进程不会无限占用内存。该输出
可能包含路径、token 或其他 secret，应按敏感信息处理。

## 名称与冲突

远程工具以如下名称暴露给模型：

```text
mcp__<server-id>__<remote-tool-name>
```

Server id 只能包含字母、数字、`_` 和 `-`。远程名称中的其他字符会转换为 `_`；长
名称会加入确定性 hash，并限制在 64 个字符。剩余任何冲突都会使启动失败。因此 MCP
工具不会静默覆盖本地工具或另一个 server 的工具。

Adapter 保留远程 `inputSchema`，并返回 MCP `content` 及可选
`structuredContent`。协议或 transport 失败变为 `MCP_TOOL_CALL_FAILED`；合法结果中
的 `isError: true` 变为 `MCP_TOOL_ERROR`，并携带有长度上限的文本细节，供模型决定
后续动作。Core cancellation 会转发给 SDK；MCP progress notification 会变成 Core
工具进度事件。

## MaybeCode 配置

MaybeCode 从 `apps.maybecode.mcpServers` 读取 stdio server：

```json
{
  "apps": {
    "maybecode": {
      "mcpServers": {
        "workspace": {
          "transport": "stdio",
          "command": "node",
          "args": ["tools/mcp-server.mjs"],
          "cwd": ".",
          "required": false,
          "env": {
            "ACCESS_TOKEN": "${MCP_ACCESS_TOKEN}"
          },
          "requestTimeoutMs": 60000,
          "maxTotalTimeoutMs": 300000,
          "maxBufferSize": 10485760,
          "stderrMaxBytes": 16384
        },
        "temporarily_disabled": {
          "enabled": false
        }
      }
    }
  }
}
```

`transport` 可省略，目前只接受 `stdio`。`mcpServers` 缺失、为 `false` 或空对象时
禁用 MCP。相对 `cwd` 从当前编码 workspace 解析；省略 `cwd` 时也使用该 workspace。
`required` 默认为 `true`；只有产品可在缺少该 server 时继续运行，才应设为 `false`。
参数不经过 shell，直接传给进程。

环境变量值可以用 `${NAME}` 引用启动 MaybeCode 的进程环境。引用缺失时，启动会失败，
而不是传入空 secret。解析后的值只保存在内存，不会加入内置 trace。配置文件是明文，
因此应优先使用引用，而不是写入 literal secret。

MaybeCode 会在打开 workspace 之前启动 MCP，把发现的工具加入普通 `ToolRegistry`，
并在 Agent workspace 关闭后、observability flush 前关闭 MCP。默认编码权限策略会要求
审批每一个 MCP 工具。`allow-for-session` 仍由正常的 MaybeCode Session permission
executor 限定作用域。

在任一 MaybeCode UI 中运行 `/mcp`，可查看已配置 server、连接状态、已发现工具、启动
错误和保留的 stderr。Controller event stream 也会向其他前端与集成暴露生命周期事件。

## Tracing 与安全

注入 tracer 后，adapter 会产生：

| Span | 含义 |
| --- | --- |
| `may.mcp.connect` | 启动子进程并进行协议初始化 |
| `may.mcp.tools.list` | 启动时的发现快照 |
| `may.mcp.tool.call` | 一次远程调用，parent 是 Core tool span |
| `may.mcp.disconnect` | 关闭 client 与进程 |

属性包括 server id、transport、公开/远程工具名、id、数量、状态，以及 tracer 计算的
耗时。内置插桩不记录 command argument、环境值、请求 input、响应 content、prompt
或 model message。

MCP server 是拥有当前主机用户权限的可执行代码，不是 sandbox；它还可以提供模型可见
的工具描述。只配置可信 server，检查其 command 与 package source，限制环境变量和
文件系统权限，并保留 permission 层。

## 当前范围

本阶段有意不包含 MCP resources、prompts、sampling/elicitation handler、HTTP
transport、server 实现、自动重连和动态 `tools/list_changed` 刷新。工具列表是启动
快照；server 修改列表后，需要下次启动 MaybeCode 才能看到。

协议细节参阅 [MCP tools 官方规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
和 [TypeScript client 文档](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/client.md)。
