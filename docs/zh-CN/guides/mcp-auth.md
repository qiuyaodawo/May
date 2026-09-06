# MCP 认证与凭据

[English](../../en/guides/mcp-auth.md) | **简体中文**

HTTP 端点的 OAuth 认证与工具执行权限相互独立。登录不会批准工具、向模型提供上下文，
也不会启动 Agent。本地 stdio 凭据仍通过显式配置的环境变量传入。

## 配置原生 OAuth 客户端

```json
{
  "apps": {
    "maybecode": {
      "mcpServers": {
        "remote": {
          "transport": "streamable-http",
          "url": "https://mcp.example.com/mcp",
          "auth": {
            "type": "oauth",
            "account": "work",
            "scopes": ["read"],
            "authorizationOrigins": ["https://accounts.example.com"]
          }
        }
      }
    }
  }
}
```

省略 `account` 时使用 `default` 凭据配置。它是本地标签，不代表已验证的远程用户身份。
端点 URL、account、客户端注册配置以及精确 issuer 共同隔离凭据；相同端点、account
和注册配置的别名共享授权。

默认只信任 MCP 端点自身 origin 上的 OAuth 网络请求。外部身份提供方需要在
`authorizationOrigins` 中列出**精确 origin**。发现、授权 URL、token 和撤销请求
拒绝其他 origin、URL 凭据/fragment 及重定向；除 loopback 外必须使用 HTTPS。
这些显式目标可以是私网地址，需要更强隔离时应施加主机网络策略。MCP 请求 header
不会转发到 OAuth 请求中。静态 `Authorization` header 不可与 OAuth 同时配置。

注册方式：

- `clientId` 加 `expectedIssuer`：预注册的**公共原生客户端**，issuer 必须精确匹配；
  不是 client-secret 或 machine-to-machine 流程。
- `clientMetadataUrl`：带文档路径的公开 HTTPS Client ID Metadata Document，
  在 server 宣告支持 CIMD 时使用。
- 否则由 SDK 在服务支持时使用旧 Dynamic Client Registration。

两个 client ID 配置不可同时使用。`callbackPort` 可指定 loopback 端口（0–65535）；
默认 0 由 OS 分配未占用端口。旧 DCR 注册不允许新回调 URL 时，会重新注册。
预注册客户端/CIMD 文档必须允许所选原生回调地址。

## 登录、刷新和退出

```sh
maybecode mcp login remote --config /path/to/config.json
maybecode mcp status remote --config /path/to/config.json
maybecode mcp login remote --scope write --config /path/to/config.json
maybecode mcp logout remote --config /path/to/config.json
```

这些命令也接受 `--workspace <path>`。登录会打印授权 URL，请在浏览器中打开。
May 只监听 `127.0.0.1`，校验随机、一次性 state，并在兑换 PKCE 绑定的 code 或读取
回调错误之前校验 issuer。Ctrl+C 或五分钟超时会关闭 listener。Code verifier 和
discovery state 都只在当前进程内存中保存；退出即取消流程，不保留可恢复的授权码。

运行时读取已存凭据，在过期或 HTTP 401 时刷新。刷新串行执行并重新发现 issuer，
不会把旧 issuer 的凭据拿到新 issuer 兑换。Transport 在刷新后最多重试一次被 401
拒绝的请求；其他工具/网络失败不会重放。HTTP 403 `insufficient_scope` 会保存已授予
与新请求 scope 的并集，返回 `MCP_AUTHENTICATION_REQUIRED`，要求显式重新登录授权，
不会在工具执行中打开浏览器。`/mcp` 会在适当时显示 `auth-required`。登录后执行
`/mcp reconnect <server-id>` 重新发现能力并创建新授权身份，也适用于首次发现失败
的端点。随后启动新 Run，不重放被拒绝的调用。

`status` 只报告是否存有 token、是否等待追加同意以及已知过期时间，并不进行远程 token
有效性验证。退出在服务宣告支持时尝试 RFC 7009 撤销，并始终清除本地授权。如果远程
撤销不可用或失败，会明确提示；必要时应到提供方撤销访问。退出不会删除远端用户数据。

## 存储与嵌入

MaybeCode 使用 `~/.may/maybecode/mcp-credentials`（程序嵌入时位于 `dataDirectory`
之下）。记录采用 AES-256-GCM、随机 nonce、绑定记录 key 的 AAD、原子写入和限制性
创建权限；32 字节主密钥通过可选依赖 `@napi-rs/keyring` 保存在系统钥匙串。较大的
refresh token 不受原生 keyring 单条记录大小限制。钥匙串锁定、缺失或不支持时直接
失败，**不会回退到明文存储**。原生 Windows backend 已做本地 smoke 验证；其他平台
需要可用的系统 keyring/Secret Service。仅移动加密文件不会迁移其 OS 绑定主密钥。

凭据操作通过独占 lock 文件串行化。进程崩溃后，应读取 `.lock` 中的 PID 并确认进程
已退出，再移除该 lock；library 不会仅凭文件年龄抢占活跃锁。无界面系统需要解锁
系统钥匙串，或注入安全存储。

Library 集成创建 `new McpOAuthManager(store)`，将它作为 `oauth` 传给
`openMcpClientPool`，或作为 `mcp.oauth` 传给 configured MaybeCode。Manager 提供
`login`、`status`、`logout`。其他安全 backend 可实现 `McpCredentialStore`；
`InMemoryMcpCredentialStore` 是显式选择的非持久方案，不是桌面默认 fallback。
登录接受 `onAuthorizationUrl` callback、`signal` 和 `timeoutMs`。

凭据、回调 code/state、OAuth response body 不加入模型消息、Session history 或内置
trace。授权 URL 仅在认证 UI 中主动展示。OAuth fetch 每次最多 30 秒、响应最多
1 MiB；server/tool 内容仍不可信。

参考：[MCP 认证规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)、
[SDK provider 义务](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)。
