# 导出 May MCP 服务端

[English](../../en/guides/mcp-server.md) | **简体中文**

本文用于向 MCP 客户端提供明确选定的 May 工具、资源或提示模板。需要可信工作区
身份、`ToolExecutor`，以及负责认证与关闭的启动程序或 HTTP 框架。

## 独立、显式启用的入口

从 `@may/mcp/server` 导入 `createMayMcpServer`。应用明确提供工具、资源、提示模板、认证、按方法/
目标授权及正常 `ToolExecutor`，缺少安全服务属于配置错误。

官方 server SDK 2.0.0 负责 serving 和协议校验。默认只服务现代 `2026-07-28`；
`legacy: "stateless"` 显式允许旧版无状态 HTTP 和 stdio 协商，不启用已移除的双端点
SSE。导出支持有大小限制的即时工具、固定资源和提示模板。不支持 Tasks/Apps
导出、资源模板、补全、订阅、主动宿主请求、进度转发或操作重放。

## 最小 stdio 示例

在 ESM TypeScript 项目安装 `@may/mcp` 和 `@may/permissions`，将以下内容保存为
`server.ts`，通过项目构建编译，再将生成的 JavaScript 作为 MCP 客户端启动命令。
Stdout 专供协议使用。示例收到 SIGINT 后清理；产品启动程序还需要将自身关闭
信号连接到同一清理流程。

```ts
import { createMayMcpServer } from "@may/mcp/server";
import { PermissionToolExecutor } from "@may/permissions";

const workspaceId = "explicit-workspace";
// 示例只导出 echo。应用需要使用自己的权限策略和审批界面。
const executor = new PermissionToolExecutor({ policy: () => "allow" });
const server = createMayMcpServer({
  endpoint: "http://127.0.0.1/mcp", // HTTP 地址配置，由宿主管理监听。
  workspaceId,
  authenticate: async () => undefined, // 示例拒绝 HTTP 访问。
  authorize: async ({ principal }) => principal.id === "local-launcher",
  executor,
  tools: [{
    tool: {
      name: "echo", description: "Echo a provided message",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      async execute(input) { return input; },
    },
    result: output => ({ content: [{ type: "text", text: JSON.stringify(output) }] }),
  }],
});
const stopped = new Promise<void>(resolve => process.once("SIGINT", () => resolve()));
try {
  server.serveStdio({ id: "local-launcher", workspaceId });
  await stopped;
} finally {
  try {
    await server.close();
  } finally {
    await executor.close();
  }
}
```

Stdio 启动程序必须建立可信本地主体，例如通过已经认证的系统会话，不能采用 stdin
参数。默认消息上限 1 MiB。自定义 transport 属于可信集成代码，须自行保持相同分帧/
大小限制。stdout 专供协议。`serveStdio` 返回 close 句柄；Server 不负责注入执行器。

## HTTP 认证和隔离

将框架的 Web `Request` 交给 `server.fetch(request)`，返回其 Web `Response`。
外部 URL 必须精确匹配 `endpoint`，除字面 loopback HTTP 外要求 HTTPS。反向代理
需保留并校验 Host/Origin，不要从不可信 forwarded header 重建 URL。只服务 POST。
浏览器 Origin 除非列入 `allowedOrigins` 否则拒绝；不提供通配 Origin、自动 CORS 或
preflight。监听器归应用负责，导入包不会暴露公网服务。

`authenticate(request, signal)` 必须验证 token/签名、audience/resource、过期及
撤销，返回 `{ id, workspaceId, expiresAt? }`，过期时间使用 Unix 毫秒。认证先于
正文解析和发现，缺少凭据返回 401，其他 workspace 返回 403。预配置 opaque bearer
token 可使用 `createMayMcpBearerAuthenticator(grants)` 的 `.authenticate` 和
`.revoke(token)`，仅保留 token 散列并采用常量时间比较。token 应是独立生成的至少
32 字符秘密。OAuth 部署需要提供 verifier、issuer 和 metadata 路由；服务端
使用宿主提供的验证方法检查 token。

每个实例固定**一个 workspace**，不采用 RPC 参数提供的路径。认证主体复制并冻结。
调用使用 Host 生成的 Run/tool-call id 和绑定主体/workspace 的导出 session 标签，
客户端 Session id 不参与这项身份生成。标签仅用于导出调用。导出工具仍负责实际文件系统
访问范围。资源和提示模板回调接收可信
principal/workspace 及 signal。

`authorize({ principal, workspaceId, signal, method, target? })` 覆盖每次请求、目录
项及操作。列表隐藏未授权项，直接访问隐藏/未知目标在回调前失败。HTTP 凭据在等待
后、实际工具副作用前及数据返回前再次检查。权限审批等待期间撤销 token 会阻止执行。

## 导出定义和限制

- `tools: [{ tool, result }]`：显式 Core Tool 白名单，验证输入 JSON Schema、运行
  `parse`、经过注入执行器，再执行带校验的 `tool.execute`。`result` 是**必需的公开
  投影**，不自动导出原始输出/事件/provider 秘密。返回合法 MCP 内容。失败使用通用
  `isError`，不返回异常载荷。复用审批需按主体隔离，工具权限身份也绑定 workspace/
  principal/定义。
- `resources: [{ definition, read }]`：固定准确 URI 白名单，`read(context)` 只返回
  该 URI 内容，不隐式映射 `file://` 或允许路径穿越。
- `prompts: [{ definition, get }]`：显式模板，`get(args, context)` 接收声明的字符串
  参数，检查必填并拒绝未知参数。不自动导出会话。

定义是快照，改变时需新建 Server。每类最多 256 个唯一导出，元数据/内容上限 8 MiB，
内容/消息最多 128 项。HTTP 正文及默认 stdio 消息上限 1 MiB，HTTP 拒绝 batch 和
订阅流。HTTP 最多 64 并发请求，每个 stdio 实例相同，最多打开 16 个 stdio 句柄。
默认请求截止时间 60 秒，可配置至五分钟。回调须遵守取消；忽略 signal 的回调已经
产生的副作用不能靠停止本地等待撤销。不重试未知结果。HTTP 使用
`Cache-Control: no-store`，资源及 SDK 目录默认零 TTL/private。关闭会中止请求及
SDK 句柄，不关闭应用监听器或注入执行器。

## 验证导出

使用[客户端连接池](mcp.md#package-api)连接。默认现代 stdio 服务端需要客户端设置
`protocolMode: "auto"`。确认目录仅提供 `echo`、传入
`{ "text": "hello" }` 返回对应 JSON 文本，以及无效输入被拒绝。HTTP 部署前还
需要检查缺少认证、未授权工作区及审批期间撤销凭据的行为。

在仓库根目录执行 `pnpm --filter @may/mcp test`，运行本地集成检查，其中包含
下述服务端测试。

`packages/mcp/test/server.test.mjs` 通过 May MCP 客户端连接真实 HTTP 端点，检查
认证/workspace 拒绝、按主体过滤发现、正常权限拒绝、审批期间撤销、公开投影、输入
校验、资源/提示、超大输入和关闭。真实 stdio 子进程检查现代/显式旧版协商及启动器
身份。这些测试覆盖对应的集成行为；完整 MCP 符合性需要独立审查。
