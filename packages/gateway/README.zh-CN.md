# `@sortedyuan/gateway`

[English](README.md) | **简体中文**

为 May 宿主提供 Agent adapter、持久化消息投递和 HTTP 服务。
需要 Node.js 22.16.0 或更新版本。

| 入口 | 功能 |
| --- | --- |
| `@sortedyuan/gateway` | Adapter、投递与 HTTP 的公开导出 |
| `@sortedyuan/gateway/adapters` | Agent adapter 接口、注册、加载和 May 接入 |
| `@sortedyuan/gateway/rpc` | 使用 stdio 或 socket 的 JSON-RPC adapter |
| `@sortedyuan/gateway/delivery` | 渠道接口、日志存储和消息投递 |
| `@sortedyuan/gateway/web-api` | 通过宿主插件管理 HTTP listener |
| `@sortedyuan/gateway/examples/rpc-file-agent` | 用于 RPC 集成的可执行文件 Agent |

`createAgentAdaptersPlugin()` 提供宿主注册表。注册表根据请求创建 adapter，
共享正在执行的创建过程，并在宿主关闭时关闭已获取的 adapter。
`createMayAgentAdapter()` 接受宿主提供的 Session 存储和 Agent 定义工厂。
RPC adapter 校验能力与执行身份，并保留无法确认结果的操作状态。

`createDeliveryPlugin()` 接受宿主 ingress，提供渠道注册和消息投递服务。
宿主负责访问规则、路由、顺序和存储管理。`ChannelStore` 保存渠道日志，
投递记录保留 receipt 和需要核查的结果。

`createWebApiPlugin()` 接受 handler 服务，并管理 listener、活动请求和连接。
宿主提供身份验证、路由与静态内容。插件关闭会取消请求 signal，并等待资源释放。

详细参考：[adapters](docs/adapters/README.md)、
[消息投递](docs/delivery/README.md)和 [HTTP 服务](docs/web-api/README.md)。
执行 `pnpm --filter @sortedyuan/gateway test` 验证文件、进程与 HTTP 行为。
[插件安装检查](../../docs/zh-CN/guides/npm-release.md)还会在仓库外项目中验证安装后的包。
