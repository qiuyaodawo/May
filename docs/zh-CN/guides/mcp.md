# MCP 工具

[English](../../en/guides/mcp.md) | **简体中文**

`@may/mcp` 使 May 应用可以使用 Model Context Protocol（MCP）服务器提供的工具，
同时不把协议和进程管理代码放进 Core。当前支持本地 stdio、远程 Streamable HTTP client 与 MCP tool
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

打开 client pool，为每次 Run 提供工具目录，并在产品 ownership 边界关闭 pool：

```ts
import { defineAgent } from "@may/application";
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
  tools: localTools,
  toolSource: () => mcp.tools,
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

打开时对每个 server 协商协议（旧版初始化或新版发现），并执行聚合的 `tools/list` 请求。Server 默认是
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

`transport` 可省略，默认 `stdio`；`streamable-http` 用于 HTTP 端点。`mcpServers` 缺失、为 `false` 或空对象时
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

## Streamable HTTP 与协议模式

同一个 `mcpServers` map（或 package 的 `servers` 数组，另加 `id`）接受：

```json
{
  "remote": {
    "transport": "streamable-http",
    "url": "https://mcp.example.com/mcp",
    "headers": { "Authorization": "Bearer ${MCP_REMOTE_TOKEN}" },
    "protocolMode": "auto",
    "requestTimeoutMs": 60000,
    "maxTotalTimeoutMs": 300000,
    "required": false
  }
}
```

Header 环境引用只由 MaybeCode 配置解析，直接调用 package API 时不会展开。
即使 server 是 optional，缺失引用也会使启动失败。当前支持静态 header 和原生
OAuth 发现、登录、刷新，参阅 [MCP 认证](mcp-auth.md)。认证不等于工具授权。HTTP entry 不接受进程专用字段 `command`、`args`、
`cwd`、`env`、`maxBufferSize`、`stderrMaxBytes`；stdio entry 不接受 `url`/`headers`。
`maxBufferSize` 仍是 stdio 消息上限，不是 HTTP 响应大小上限。

`protocolMode` 接受 `legacy` 或 `auto`。Stdio 默认 legacy，保留原启动行为；HTTP
默认使用 SDK auto 模式，通过 `server/discover` 发现新版 server，并在适当时回退到
旧版 `initialize` 握手。主动启用 stdio auto 可能额外启动一个短生命周期探测进程。
项目已安装的 `@modelcontextprotocol/client@2.0.0` 支持该可选模式，但 SDK 默认仍是
legacy。本地集成 fixture 验证了 2025-11-25 stdio/HTTP 和 2026-07-28 HTTP tools
链路，并不代表完整协议合规或第三方 server 兼容认证。`/mcp` 和 `pool.status()` 显示
协商后的协议版本；Core 仍不依赖协议版本。参阅
[SDK 协商说明](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/client/client/client.html)。

除 `localhost`、`127.0.0.1`、`[::1]` 可用 HTTP 外，只接受 HTTPS。拒绝 URL 中的
用户名、密码和 fragment；凭据应使用 header，不要写入 URL query。任何重定向都不
跟随，包括同源重定向。拒绝大小写不敏感的重复 header、无效 header，以及对 `mcp-*`、
`Host`、`Connection`、`Content-Length`、`Transfer-Encoding`、`Upgrade`、`Accept`、
`Content-Type`、`Origin`、`Cookie`、`Proxy-Authorization` 的覆盖。
配置的端点是可信目标，并非网络沙箱；HTTPS 不会阻止私网访问，需要时应在 adapter
之外施加网络策略。远程工具会把参数发送给该目标，仍经过正常工具权限层。

HTTP SDK 错误可能在 URL、响应 body 或 cause 中带有 secret，因此公开错误、状态和
tracing 不展示这些细节，仅在可获得时保留 HTTP status code。MCP `isError` 工具结果
仍向调用方提供有界文本，但 HTTP error span 不记录该文本。Span 不添加 HTTP header
或 URL，HTTP 端点也没有 stderr 末尾片段。

不启用自动重连、stream 恢复或通用工具调用重试，也不回退到旧 HTTP+SSE。`connected`
表示建立和工具发现成功，不代表持续健康检查；单次 HTTP 失败只使对应操作失败，不会
自动移除已发现工具。关闭时对协商出的旧版 HTTP session 尝试 DELETE（最多五秒，
或更短的 request timeout），随后无论结果如何都关闭本地 transport 资源；这不会删除
远端用户数据。新版协议不会创建远端协议 session。

## Tracing 与安全

注入 tracer 后，adapter 会产生：

| Span | 含义 |
| --- | --- |
| `may.mcp.connect` | 建立 transport 并协商协议 |
| `may.mcp.tools.list` | 首次及刷新时的能力目录发现 |
| `may.mcp.tool.call` | 一次远程调用，parent 是 Core tool span |
| `may.mcp.disconnect` | 关闭 client 与进程 |

属性包括 server id、transport、公开/远程工具名、id、数量、状态，以及 tracer 计算的
耗时。内置插桩不记录 command argument、环境值、请求 input、响应 content、prompt
或 model message。

本地 stdio MCP server 是拥有当前主机用户权限的可执行代码，不是 sandbox；它还可以提供模型可见
的工具描述。只配置可信 server，检查其 command 与 package source，限制环境变量和
文件系统权限，并保留 permission 层。

## 当前范围

工具和元数据目录（resources/templates/prompts）现已支持动态发现。资源读取/附件、
prompt、completion 和 watch 也已实现，详见下文。有归属的 elicitation、
Roots/Sampling 和显式旧协议交互兼容均已实现。已实现显式启用的 Tasks；server 实现仍是
独立阶段；已移除的双端点 HTTP+SSE 传输不会启用。重连需要显式操作，绝不自动重放工具调用。

剩余阶段参阅 [MCP Host 路线与验收](../architecture/mcp-host-roadmap.md)。

协议细节参阅 [MCP tools 官方规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
和 [TypeScript client 文档](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/client.md)。

## 动态目录与端点恢复

在 Agent definition 的静态 `tools` 之外使用 `toolSource: () => mcp.tools`；
将 `mcp.tools` 直接传入构造器则有意固定当时的集合。配置式 MaybeCode 已自动使用
动态来源，包括切换模型/Session 之后。新目录仅影响下一次 Run/continue，不修改
运行中的 Run。定义变化/移除或目录失效时，旧快照抛出 `MCP_STALE_TOOL`，不发送
远程请求。重连关闭旧连接，因此它的快照不能继续执行。

- `mcp.catalog()` 返回深度冻结的每端点元数据：revision、capabilities、tools、
  resources、resourceTemplates、prompts。只查询声明的能力，也支持仅提供资源的
  端点。元数据是不可信服务端数据，不意味着允许加载 URI 或执行 prompt。
- `await mcp.refresh(serverId?, signal?)` 重新请求声明的列表，只有完整候选目录才
  会发布。每列表最多 64 页；重复 cursor/身份会失败。所有列表保留的候选目录合计
  最多 4,096 项/8 MiB。刷新期限为 60 秒或 `maxTotalTimeoutMs`。这是目录限制，
  并非 HTTP 响应体内存沙箱。
- 收到声明支持的列表变更通知后立即使工具失效，并合并调度一次刷新。现代协议
  使用 `subscriptions/listen`，旧协议使用通知 handler。刷新期间继续变更最多重试
  三次发现；失败保留旧元数据并标记 stale，新 Run 不再暴露这些工具。不会自动
  读取内容或附加上下文。
- `await mcp.reconnect(serverId, signal?)` 仅替换指定端点，包括启动失败的 optional
  端点。存在运行中工具调用时重连失败，避免中断/重放结果未知的副作用。旧 Run
  快照需要放弃；新连接取得新的权限身份。
- 两种终端 UI 支持 `/mcp refresh [server-id]` 和 `/mcp reconnect <server-id>`。
  `/mcp` 显示 revision/stale 和通知覆盖状态（`active`、`partial`、`unavailable`、
  `legacy`、`not-advertised`）。现代订阅流断开会显式报告失败，不能伪装为健康订阅；
  需要显式刷新/重连。`mcp.server.catalog-updated` 表示目录发布。

工具授权身份包含完整远程定义（包括 output schema/annotations）、端点/账户配置
以及连接代次，不暴露配置秘密。定义未变的刷新保留授权；重连/故障恢复产生新身份。
显式 OAuth 登录后，先执行 `/mcp reconnect <server-id>` 再启动新 Run。每连接独享
缓存；目录保存在 pool 内存中，显式刷新不会信任旧 TTL。关闭会取消排队/运行中的
目录发现和订阅。

## 资源、提示词、补全与附件

Pool 提供宿主/用户驱动的 `readResource`、`readResourceTemplate`、`getPrompt`、
`complete` 和 `subscribeResource`，**不会自动作为模型工具导出**。仅基于已授权
用户意图或显式宿主策略调用；MCP 凭据不替代应用访问控制。方法接受取消信号和
trace context，复用端点生命周期。

```ts
const read = await mcp.readResource("workspace", "project:///README", { signal });
const expanded = await mcp.readResourceTemplate(
  "workspace", "project:///{path}", { path: "README" }, { signal },
);
const prompt = await mcp.getPrompt("workspace", "review", { file: "main.ts" }, { signal });
const suggestions = await mcp.complete("workspace", {
  ref: { type: "ref/prompt", name: "review" },
  argument: { name: "file", value: "ma" },
}, { signal });
const watch = await mcp.subscribeResource("workspace", read.uri, { signal });
// watch.events 只有 { type: "updated", serverId, uri }，没有新内容。
await watch.close(); // watch.closed 也报告远端/连接终止。
```

两种终端 UI 均支持以下命令。JSON 直接输入，不加 shell 引号；内部空白保留：

```text
/mcp catalog [server-id]
/mcp read server-id resource-uri
/mcp template server-id uri-template {"path":"README"}
/mcp prompt server-id prompt-name {"file":"main.ts"}
/mcp complete server-id {"ref":{"type":"ref/prompt","name":"review"},"argument":{"name":"file","value":"ma"}}
/mcp attach server-id resource-uri 这个资源包含什么？
/mcp use-prompt server-id prompt-name {"file":"main.ts"}
/mcp watch server-id resource-uri
/mcp unwatch server-id resource-uri
```

`read`、`template`、`prompt` 仅预览；`attach`、`use-prompt` 以 **user message** 显式
启动 Run，准备和提交在同一 Session 状态队列内原子执行。Ctrl+C/关闭取消准备，
不会将数据附加到随后切换的 Session。远端 prompt 的角色标签只是数据，不是实际
assistant/system 历史。`mcpResourceToUserMessage`、`mcpPromptToUserMessage` 保留
不可信 MCP 来源信息。Resource link 保持惰性 JSON，不触发本地文件读取或 URL
自动下载。Watch 通知不改变模型 Context。

每结果最多 128 块/8 MiB，验证 base64/MIME；超限失败，不静默截断结构化数据或
二进制。终端预览最多 16,000 字符，二进制仅显示标签。媒体转换为 provider-neutral
base64 内容；模型不支持时通过 `UnsupportedContentError` 明确失败，不偷偷转成
文本。通用 `Tool.resultContent` hook 向模型投影多模态与 structured output，工具
事件保留原始结果；`_meta` 仅供宿主使用。补全验证目录引用/参数名，每次最多
100 项/64 KiB，每连接每秒最多 10 次。终端按 Enter 才请求，GUI 应对输入 debounce。

资源 LRU 遵循正 TTL，最多五分钟；每连接最多 32 项/16 MiB，缺少 TTL 不复用。
`cache: "refresh"` 强制读取，`"bypass"` 不读写缓存。资源/列表通知使缓存失效；
读取期间收到更新则不写回过期数据。即使结果宣告 `public`，也不跨端点/账户/连接
共享。命中前及读取后检查 OAuth 授权代次，另一个进程登录/退出不能暴露旧私有
缓存；授权变化后需重连。

现代 watch 使用 `subscriptions/listen`，旧版使用 subscribe/unsubscribe。同 URI
共享引用计数远端流，各 handle 独立取消并缓冲最多 32 条通知；每连接最多 64 个
handle。流断开会完成 `closed`，不悄悄自动重连。关闭释放全部 handle。HTTP JSON
响应和每 SSE frame 在 SDK 解析前限制 10 MiB；stdio 保留可配置限制，并保证通知/
响应有序投递。

## 有作用域的用户交互（现代 MRTR）

现代 `tools/call`、`resources/read`、`prompts/get` 可以暂停并请求表单或 URL
交互。Host 将续接绑定到原始逻辑请求，而不是服务端提供的 Session id 或碰巧正在
运行的 Run。SDK 负责新的 wire id 和原样回传不透明的 `requestState`；这是协议
续接，**不是**重试结果不确定的工具操作。参阅
[MRTR 规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)。

MaybeCode 的两个终端界面都会启用交互：展示服务端及 Session，输入 JSON 表单，
允许修改，并要求单独输入 `send` 确认发送。也可以明确 `decline` 拒绝或 `cancel`
取消。表单答案不进入输入历史；不要在表单中输入凭据。URL 模式展示 HTTPS 主机和
完整地址，询问同意后由用户自行访问，再输入 `retry` 手动继续。客户端不抓取地址、
不自动打开浏览器、不转发 MCP 凭据，也不会将同意解释为外部流程已经完成。这与
MCP 客户端 OAuth 登录相互独立。参阅
[Elicitation 规范](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)。

库/headless 使用必须显式启用：

```ts
import { McpInteractionBroker, openMcpClientPool } from "@may/mcp";
const interactions = new McpInteractionBroker();
const pool = await openMcpClientPool({ servers, interactions });
const owner = { workspaceId: workspaceIdentity, sessionId };
// 同时消费 interactions.events，并实现明确的用户界面。
// requested 事件需核验本地 owner，获得用户检查后的答案，再调用：
// interactions.respond(request.id, request.owner, userReviewedResponse)
const read = await pool.readResource("remote", "project:///README", { owner, signal });
await pool.close(); // 同时关闭由 pool 拥有的 broker
```

每个 pool 使用独立 broker 和一个 UI 消费者，不跨 pool 共享。事件流有界且是
best-effort；可通过 `list(owner)` 恢复当前待答问题。没有 UI 时省略 broker：此时
不声明 elicitation 能力，收到输入请求会安全失败，不会调用模型。库入口
`openConfiguredMaybeCode` 同样默认不创建 broker；只有能够消费并回答 controller
事件时才传入 `mcpInteractions: true`。交互式 CLI 会自动启用。

工具调用使用 `MayOptions.toolScope()` 提供可信 Host 字符串标签；Core 每个 Run
只快照一次，并放入 `ToolExecutionContext.scope`，而非模型参数。
`AgentApplication` 接受 Host 的 `toolScope` 标签并覆盖为自身 `sessionId`；
MaybeCode 将解析后的 workspace 作为 `workspaceId`。直接执行 pool 工具的调用方
须自行提供这两个标签。MCP 适配器补充 Run/tool-call id 和随机逻辑请求 id；owner
标签不会进入 MCP `_meta`。Host 主动操作使用 `McpOperationOptions.owner`。
缺少可信归属时不发起交互式提问。

产品 UI 消费 `mcp.interaction.requested` / `settled`，通过
`getMcpInteractions()` 查询、`respondMcpInteraction(id, response)` 回答。回答刻意
绕过 Session 状态队列，避免资源准备或工具占用队列等待自身答案的死锁。读取/预览
和附件准备在执行中固定 Session；取消会释放排队的 Session 切换。Retained 弹窗
临时存在、可滚动查看、独立取消，不会把表单作为新的 agent turn 提交。

限制：8 轮协议续接，每个逻辑流程共最多 32 个 Host 输入请求，每个 pool 最多
32 个待答问题，每个表单最多 32 个字段，请求/响应各 64 KiB，说明文字最多 4,096
字符。支持扁平基本类型及单选/多选枚举；不支持的 schema 关键字、外部引用、任意
正则表达式会被拒绝。响应校验不做类型强制转换、不自动填写默认值，并拒绝额外字段。
绝对期限覆盖 UI 等待和全部网络往返，默认 60 秒，通过 `maxTotalTimeoutMs` 配置。
取消/过期/关闭会移除待答项、取消排队弹窗，拒绝迟到、重复或归属错误的答案。
每次续接前重新校验认证身份及目录/工具有效性；提问期间切换登录不会在新身份下发送
旧的请求状态。资源缓存额外按照 workspace 和 Session 分区。

Broker 不单独持久化或追踪问题与答案，但服务端仍可能将提交的数据作为正常资源/
工具结果返回。无归属的旧 push 请求直接拒绝；显式隔离的旧协议操作可以交互，详见下文。
Roots/Sampling 是显式兼容选项，不会仅因安装 server 就启用。Tasks 需单独显式启用；server
导出仍是待完成的路线图项目；本功能不代表完整 MCP 一致性。


## Roots、Sampling 与旧协议兼容

Roots 和 Sampling 都是**默认关闭**的显式兼容能力。MCP 2026-07-28 已将两者标记
为 deprecated；新集成宜通过模型服务商的直接 API 获取模型能力。参阅官方
[Roots](https://modelcontextprotocol.io/specification/2026-07-28/client/roots) 和
[Sampling](https://modelcontextprotocol.io/specification/2026-07-28/client/sampling) 规范。
启用不等于授权读取 Session 历史或执行宿主工具。

在 MaybeCode 的单个 stdio 或 HTTP 服务端配置中，分别显式开启：

```json
"host": {
  "roots": true,
  "sampling": true,
  "legacyRequests": "isolated"
}
```

同时需要正在处理交互的 broker/UI。直接使用包 API 时，通过
`hostServices: McpHostServices` 提供 `roots(context)` 白名单回调和/或
`sampling.createMessage(params, context)`。有 broker 却缺少已开启的服务时配置
失败；没有 broker 时不声明任何 Host 能力。回调只接收可信 owner、逻辑请求 id、
截止时间和取消信号，不获得 Core Context；自定义服务必须检查归属。

- **Roots**：MaybeCode 仅提供当前 workspace。宿主规范化可访问的本地 `file:`
  路径、去重，展示只读审批后才发送；拒绝则返回空列表，服务端不能指定路径。
  上限为 32 个根 / 64 KiB，同意后再次检查可访问性。Roots 仅为提示，**不是沙箱
  或文件访问授权**。不声明 `roots.listChanged`，每次请求重新获取候选根。
- **Sampling**：UI 先检查/编辑确切的隔离输入，再单独检查/编辑输出后才向服务端
  披露；拒绝输出不能撤销已产生的模型费用。输入/结果各限 48 KiB，最多 64 条消息、
  32 个工具；每次最多 4,096 输出 token，每个逻辑流程最多四次调用 / 16,384 个
  预留输出 token。拒绝除 `none` 外的 `includeContext`，不隐式重试或加入 Session。
- `createMcpModelSampler(factory)` 适配宿主选择的协议无关 `Model`：每次创建单独
  有界请求，不经过 May 执行循环或 ToolRegistry。factory 接收已批准的 `maxTokens`，
  必须在服务商层落实；模型需声明不超过该值的正数 `limits.maxOutputTokens`。
  MaybeCode 用当前 profile 创建独立的基础 provider 实例，并同时覆盖 `maxTokens`
  和 `maxOutputTokens`。此桥接器不转发服务端可选的 model/temperature/stop 提示或
  请求 metadata，由宿主 provider 配置决定。
- Sampling 工具是**提议，不是执行**。仅发送服务端声明的工具定义；转换
  tool-use/result 历史，但绝不调用本机工具。文本、支持的内联图片/音频及工具历史
  均有大小限制，不支持的输出显式失败，不获取 URL/文件。隐去 reasoning、model
  state 和响应 `_meta`。自定义 sampling 服务可不声明 `supportsTools`。

每次披露前重新检查认证/目录状态。取消或过期会停止本地等待并移除审批；迟到的
回调结果被丢弃。向服务端返回前会隐藏文件系统/provider 错误细节。自定义回调必须
遵守 signal 与 provider 预算：宿主无法强制终止任意 JavaScript，也不能撤销远端
已经处理的模型请求。

`legacyRequests: "isolated"` 使适用的旧版 `tools/call`、`resources/read` 和
`prompts/get` **每次使用全新进程（stdio）或连接/session（HTTP）**，每个端点最多
八个并发子连接。发送用户操作前需确认子连接协议和完整目录与父连接一致，交互期间
继续检查父/子连接有效性。通道只有一个可信 owner，绝不复用，完成/取消/池关闭时
销毁，不重放结果不确定的操作。命中资源缓存也可能产生子连接发现开销。
这些操作之间**不保留进程/session 状态**，只适合支持独立会话的服务端。未启用时
普通共享旧版工具仍可使用，但无归属/启动阶段回调不猜测 owner：elicitation 拒绝、
roots 为空、sampling 失败。


现代 Tasks 已支持持久句柄、显式 get/update/wait/cancel、重启恢复及用户主动附加
完成结果。设置 `tasks: true` 并提供 journal；版本、UI 和安全边界参阅[长任务](mcp-tasks.md)。

可选图形集成及终端 fallback 参阅[隔离 Apps Host](mcp-apps.md)。
