# 配置 MCP OAuth 认证

[English](../../en/guides/mcp-auth.md) | **简体中文**

本文用于在 MaybeCode 或自定义原生宿主中认证 Streamable HTTP 端点。需要服务端的
OAuth 注册要求、可信认证来源、浏览器，以及可用的系统钥匙串或安全凭据存储。
按照[MCP 指南](mcp.md)配置端点。

OAuth 建立远程账户身份，应用单独检查每次工具执行权限。Stdio 服务端通过配置
的环境变量取得凭据。

## 配置原生 OAuth 客户端

1. 在 May 配置的 HTTP 端点中添加 `auth`。
2. 将示例端点、scopes 和认证来源替换为服务端接受的值。

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

省略 `account` 使用 `default` 凭据配置。Account 是本地标签；实际远程身份由
服务端认证。端点 URL、account、客户端注册配置和精确 issuer 共同隔离凭据。
相同端点、account 和注册配置的别名共享授权。

默认信任 MCP 端点来源的 OAuth 网络请求。外部身份服务需要在
`authorizationOrigins` 中列出精确来源。发现、授权、token 和撤销请求拒绝其他
来源、URL 凭据、fragment 和重定向。除本地回环地址外要求 HTTPS。宿主负责私有
网络访问策略；MCP headers 不转发给 OAuth。静态 `Authorization` 与 OAuth
不能同时配置。

| 注册配置 | 使用要求 |
| --- | --- |
| `clientId` 与 `expectedIssuer` | 预注册的公共原生客户端，issuer 精确匹配；采用客户端秘密的机器认证需要其他集成 |
| `clientMetadataUrl` | 带文档路径的公开 HTTPS Client ID Metadata Document，服务端需要支持 CIMD |
| 省略上述配置 | 服务端声明支持时，由 SDK 使用 Dynamic Client Registration |

两种 client ID 配置不能同时使用。`callbackPort` 接受 0–65535，默认 `0` 选择
未占用端口。已保存 DCR 注册不允许新的回调 URL 时重新注册。预注册客户端和
CIMD 文档需要允许选定的原生回调地址。

## 登录、刷新和退出

1. 在仓库根目录使用刚编辑的配置执行登录。使用已安装 CLI 时，将
   `pnpm maybecode` 替换为 `maybecode`。

```powershell
pnpm maybecode mcp login remote --config ./may.config.json
pnpm maybecode mcp status remote --config ./may.config.json
```

2. 在浏览器打开显示的授权地址，同意所需 scopes。登录完成后，凭据保存到安全存储。
3. 如果 MaybeCode 已经运行，执行 `/mcp reconnect remote`。通过 `/mcp` 检查连接
   状态，随后启动新的 Run。
4. 需要增加权限范围或删除本地凭据时，执行：

```powershell
pnpm maybecode mcp login remote --scope write --config ./may.config.json
pnpm maybecode mcp logout remote --config ./may.config.json
```

命令也接受 `--workspace <path>`。登录只监听 `127.0.0.1`，校验随机且只能使用
一次的 state，并在兑换 PKCE code 或处理回调错误前验证 issuer。Ctrl+C 或五分钟
期限关闭监听器。Code verifier 和发现状态保存在当前进程，退出后取消登录。

运行请求在凭据过期或 HTTP 401 时串行刷新，并重新发现 issuer。旧 issuer 凭据
只向原 issuer 兑换。刷新后，401 拒绝的请求最多重试一次；其他网络或工具错误不
重放。HTTP 403 `insufficient_scope` 保存已有与请求 scopes 的并集，返回
`MCP_AUTHENTICATION_REQUIRED`，要求明确重新登录。工具执行期间不会打开浏览器。

登录记录不透明授权代次。新的操作、缓存命中和 MRTR 续接校验该代次。再次登录
或退出，包括其他进程的操作，使旧连接失效；重连后重新发起操作。Token 刷新
保留相同代次。

`status` 报告是否保存 token、是否等待追加同意及已知过期时间，不检查远程有效性。
退出在服务端支持时尝试 RFC 7009 撤销，并始终删除本地授权。远程撤销不可用或
失败时显示原因，必要时在服务端撤销访问。远程用户数据保持不变。

## 存储与嵌入

MaybeCode 默认使用 `~/.may/maybecode/mcp-credentials`，程序嵌入时位于
`dataDirectory` 下。记录使用 AES-256-GCM、随机 nonce、绑定记录 key 的 AAD、
原子写入及限制性创建权限。32 字节主密钥通过可选 `@napi-rs/keyring` 保存在
系统钥匙串，较大的 refresh token 保存在加密文件中。

钥匙串锁定、缺失或不可用时直接失败。Windows 原生后端具有单独的本地检查；
其他平台需要可用的系统钥匙串或 Secret Service。迁移加密文件时还需要对应的
系统主密钥。

独占 `.lock` 文件管理凭据操作。崩溃后读取其中 PID，确认进程已经退出，再删除
该文件。无界面系统需要解锁钥匙串，或提供安全存储。

库集成创建 `new McpOAuthManager(store)`，将其作为 `oauth` 传给
`openMcpClientPool`，或作为 `mcp.oauth` 传给配置式 MaybeCode。Manager 提供
`login`、`status` 和 `logout`。其他后端实现 `McpCredentialStore`；明确选择
`InMemoryMcpCredentialStore` 时，退出后不保留凭据。登录接受
`onAuthorizationUrl`、`signal` 和 `timeoutMs`。

凭据、回调 code/state 和 OAuth 响应正文不进入模型消息、Session 历史或内置追踪。
授权 URL 仅在认证 UI 显示。OAuth 请求最多 30 秒，单个响应最多 1 MiB。
服务端及工具内容需要按不可信数据处理。

## 故障检查

| 现象 | 检查与处理 |
| --- | --- |
| OAuth 来源被拒绝 | 在 `authorizationOrigins` 添加身份服务的精确可信来源 |
| 回调无法完成 | 检查注册回调地址和本地端口，在五分钟期限内重新登录 |
| 凭据存储不可用 | 解锁或配置系统钥匙串，或者提供安全 `McpCredentialStore` |
| 崩溃后存在锁文件 | 验证其中 PID 已退出，再删除那个明确的 `.lock` 文件 |
| `MCP_AUTHENTICATION_REQUIRED` | 完成追加 scope 的明确登录，重连后启动新 Run |

连接和归属限制参阅[MCP 能力参考](../reference/mcp-capabilities.md)。
