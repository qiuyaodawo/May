# 隔离的 MCP Apps

[English](../../en/guides/mcp-apps.md) | **简体中文**

## 显式启用图形 Host

May 为 [MCP Apps 扩展](https://apps.extensions.modelcontextprotocol.io/) 提供后端 App
会话、浏览器挂载适配器和独立 origin 的 sandbox 文档。UI 协议固定为 `2026-01-26`，
与 MCP 连接协议独立。这是有意收紧的 Host，不声称支持所有可选 Apps API。

仅在图形 Host 中向 `openMcpClientPool` 传入 `apps: { executor, approve }`。
`executor` 必须是正常权限执行器；`approve` 必须明确审阅打开资源及后续每次资源
读取，并遵守 signal。没有默认允许策略。这会声明 `io.modelcontextprotocol/ui`
及 `text/html;profile=mcp-app`。用户明确操作后调用
`pool.openApp(serverId, remoteToolName, { owner, signal })`。owner 来自可信 Host
workspace/Session，不能取自 App 参数。

返回的 `McpAppSession` 提供 `resource`、`receive(message)`、
`notification(kind, params)`、`close()`，必须留在后端。只绑定一条经认证的渲染通道，
不要暴露池、执行器、凭据、任意 RPC 转发或 Session 历史。传入在 Session 切换、
退出登录和 UI 销毁时中止的生命周期 signal。默认视图十分钟，最长一小时；每连接
最多 16 个打开/打开中的视图，每视图四个并发请求、256 个唯一请求 id。重复 id
关闭视图，不重放动作。重连、失效、目录或认证变化及池关闭使旧视图不能继续操作。

## 浏览器集成

在**不同的独立 origin** 上提供 `mcpAppSandboxResponse(hostOrigin)`，完整保留其
HTTP headers 和 body。该 origin 不应具有 cookie、凭据、其他应用路由或托管不可信
内容。生产环境应使用分离的 HTTPS origin；本地测试允许字面 loopback HTTP。
sandbox URL 是可信 Host 配置，不采用 `_meta.ui.domain`。

```ts
// 浏览器 bundle：此子路径不导入 Node 模块。
import { mountMcpApp } from "@may/mcp/apps-browser";
const view = mountMcpApp(container, trustedSandboxUrl, {
  resource: { html: backendAppResource.html },
  receive: message => authenticatedChannel.request(message),
  close: () => authenticatedChannel.close(),
  signal: viewLifetimeSignal,
});
```

外层代理使用独立 origin 和 iframe sandbox；内层视图为 opaque origin，只允许脚本。
两跳均检查消息 source/origin。代理 HTTP CSP 和内层策略禁止网络 fetch、外部脚本/
资产、嵌套 frame、表单、插件和 base 改写；允许内联脚本/样式及 data 图片/媒体。
服务端要求的 CSP 域、权限和持久 origin **不会**放宽策略。摄像头、麦克风、定位和
剪贴板默认拒绝。依赖外部资源的 App 可能无法工作，应提供自包含 HTML 或保留文本
fallback。浏览器仍控制视图自身导航；代理在后续导航时移除视图。不要把 CSP 视为
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

## 终端 fallback 与验证

MaybeCode 终端不启用/声明 Apps。`/mcp apps` 明确提示不能执行 HTML；正常的模型
可见工具文本仍可用，app-only 工具隐藏，不自动获取 UI 资源。配置不能悄悄安装浏览器
Host。普通资源附件仍是数据，而非可执行 HTML。

`packages/mcp/test/apps.test.mjs` 检查远端执行前权限拒绝、visibility、归属路由、
资源同意、旧视图失效及 fallback。可选真实 Chromium 测试验证双 iframe origin
隔离、CSP 阻止 fetch、伪造来源拒绝和销毁。设置 `MAY_PLAYWRIGHT_MODULE` 为已安装
Playwright 模块路径，必要时设置 `MAY_CHROMIUM_PATH` 即可运行；普通测试不需要
下载浏览器或增加测试依赖。

即使自定义同意/执行器回调忽略 signal，Host 也可中止本地等待；迟到完成不会重放或
交给已关闭视图。回调仍应遵守取消，才能停止其自身工作。
