# 集成隔离的 MCP Apps

[English](../../en/guides/mcp-apps.md) | **简体中文**

本文用于为提供自包含 MCP App HTML 的服务端构建图形宿主。需要后端连接池、正常
权限执行器、用户同意界面、经过认证的浏览器通道和独立沙箱来源。MaybeCode 终端
显示工具文本，不执行 Apps。

## 显式启用图形 Host

May 为 MCP Apps 扩展 `io.modelcontextprotocol/ui` 提供后端 App 会话、浏览器
挂载适配器和独立来源的沙箱文档。UI 协议固定为 `2026-01-26`，独立于 MCP
连接协议。支持的操作与限制见下文。

1. 在图形宿主中向 `openMcpClientPool` 传入 `apps: { executor, approve }`。
`executor` 必须是正常权限执行器；`approve` 必须明确审阅打开资源及后续每次资源
读取，并遵守 signal。没有默认允许策略。这会声明 `io.modelcontextprotocol/ui`
及 `text/html;profile=mcp-app`。用户明确操作后调用
`pool.openApp(serverId, remoteToolName, { owner, signal })`。owner 来自可信 Host
workspace/Session，不能取自 App 参数。

2. 用户同意后，将返回的 `McpAppSession` 保存在后端。它提供 `resource`、
   `receive(message)`、`notification(kind, params)` 和 `close()`。只绑定一条认证渲染通道，
不要暴露池、执行器、凭据、任意 RPC 转发或 Session 历史。传入在 Session 切换、
退出登录和 UI 销毁时中止的生命周期 signal。默认视图十分钟，最长一小时；每连接
最多 16 个打开/打开中的视图，每视图四个并发请求、256 个唯一请求 id。重复 id
关闭视图，不重放动作。重连、失效、目录或认证变化及池关闭使旧视图不能继续操作。

## 浏览器集成

在独立于应用的来源提供 `mcpAppSandboxResponse(hostOrigin)`，完整保留返回的
HTTP headers 和正文。该来源不能保存 cookie、凭据或其他应用路由，也不能托管
其他不可信内容。生产环境使用独立 HTTPS 来源；本地测试允许字面回环地址 HTTP。
沙箱 URL 由可信宿主配置提供，不采用 `_meta.ui.domain`。

3. 使用绑定后端会话的通道挂载浏览器视图。以下片段假设已有 DOM `container`、
   宿主配置的 `trustedSandboxUrl`、经过同意的 `backendAppResource`、
   `authenticatedChannel` 和视图取消信号。

```ts
// 浏览器入口不导入 Node 模块。
import { mountMcpApp } from "@may/mcp/apps-browser";
const view = mountMcpApp(container, trustedSandboxUrl, {
  resource: { html: backendAppResource.html },
  receive: message => authenticatedChannel.request(message),
  close: () => authenticatedChannel.close(),
  signal: viewLifetimeSignal,
});
```

4. Session 切换、退出登录或 UI 清理时，触发取消信号，同时关闭浏览器视图和
   后端会话。通道的 `close()` 需要调用后端 `app.close()`，认证传输由宿主管理。

`McpAppChannel.lifetimeMs` 默认十分钟，最长一小时。后端使用更长有效期时，
向通道提供同样经过宿主批准的有效期。

外层代理使用独立来源和 iframe sandbox；内层视图具有不透明来源，只允许脚本。
两层检查消息 source/origin。代理 HTTP CSP 和内层策略禁止网络请求、外部脚本、
外部资源、嵌套 frame、表单、插件和 base 改写；允许内联脚本、样式及 data 媒体。
服务端要求的 CSP 域、权限和持久 origin **不会**放宽策略。摄像头、麦克风、定位和
剪贴板默认拒绝。依赖外部资源的 App 可能无法工作，应提供自包含 HTML 或保留文本
显示。浏览器仍控制视图自身导航；代理在后续导航时移除视图。不要把 CSP 视为
防止 App 泄露任意已收到秘密的通用保护，只提供用户批准向该服务端分享的数据。

使用 `ui/initialize` / `ui/notifications/initialized` 握手。支持 `ping`、经正常权限
链路的同 server `tools/call`，以及经批准读取关联 UI/目录资源的 `resources/read`。
强制执行工具 visibility：app-only 不进入模型工具表，model-only 不可由 App 调用，
名称不能路由至其他 server。visibility 格式异常时拒绝。关联 `ui://` 资源可不出现在
公开资源目录，但须校验准确 URI/MIME 和有界 HTML。

初始化完成后，通过 `view.send(await app.notification("tool-result", result))`
（跨进程使用经认证的后端等价调用）显式发送 Host 选择的输入/结果/取消通知。
不自动截取结果或挂载视图；自定义 Host 决定何时打开、分享哪次原始调用的数据。
不支持 `ui/message`、`ui/update-model-context`、自动导航、外链打开、App 提供的
Host 工具、显示模式切换或日志转发。不支持的请求明确报错，不修改 Context，也不
偷偷转发。HTML 上限 2 MiB，传入 RPC 上限 256 KiB，结果沿用 8 MiB 限制。
销毁时同时关闭浏览器 mount 和后端 session。

## 终端显示与验证

MaybeCode 终端不启用/声明 Apps。`/mcp apps` 明确提示不能执行 HTML；正常的模型
可见工具文本仍可用，app-only 工具隐藏，不自动获取 UI 资源。配置不能悄悄安装浏览器
Host。普通资源附件按照数据处理。

`packages/mcp/test/apps.test.mjs` 检查远端执行前权限拒绝、visibility、归属路由、
资源同意、旧视图失效及 fallback。
`packages/mcp/test/browser/apps.test.mjs` 使用 Chromium 验证双 iframe origin
隔离、CSP 阻止 fetch、伪造来源拒绝和销毁。执行
`pnpm --filter @may/mcp exec playwright install chromium`，然后执行
`pnpm --filter @may/mcp test:browser`。CI 仅在 Linux 的 Node.js 24 环境运行这项
浏览器检查，默认离线测试不启动浏览器。

即使自定义同意/执行器回调忽略 signal，Host 也可中止本地等待；迟到完成不会重放或
交给已关闭视图。回调仍应遵守取消，才能停止其自身工作。

## 完成检查

确认打开视图和资源读取需要同意、工具调用经过通常的权限执行器、导航及 Session
切换清理视图，以及旧通道拒绝请求。使用真实的两个独立来源执行浏览器检查。
上面的仓库浏览器命令检查来源隔离，无需外部模型账户。
