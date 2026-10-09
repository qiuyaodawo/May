# 构建自定义 UI

[English](../../en/guides/custom-ui.md) | **简体中文**

本文用于将已有 UI 接入 May 的无界面控制接口。需要已经打开的 `AgentApplication`
或工作区 controller，以及能够同时接收异步事件、取消操作和审批响应的 UI。

浏览器界面参阅[共享 Web UI](web-ui.md)：`@may/ui-client` 提供 JSON 边界和状态
同步，`@may/web-ui` 提供可组合组件与可选工作台。本文也说明进程内 controller
与 TUI 的接入方式。

终端、桌面、Web 或远程 UI 通过 `AgentController` 管理一个活动 Session，通过
`AgentWorkspaceController` 管理多个 Session。UI 调用表达用户意图的方法，并将
异步事件转换为显示状态。

完整 Session 事件提供持久历史；流式增量和进度用于实时更新。断线重连时重新读取历史。

## Headless controller 边界

1. 从应用宿主取得 controller。以下片段假设 `controller` 已经打开，`requestId`
   对应当前等待中的审批。
2. 提交输入前启动事件消费。
3. 需要等待执行结束时，等待 `run.result`。

```ts
const run = await controller.submit({ input: "Explain this repository" });
run.cancel("Cancelled in UI");        // 取消此 Run。
controller.cancel("Cancelled in UI"); // 取消活动 Run 或压缩操作。

await controller.resolveApproval(requestId, "allow");
await controller.compactContext();
const history = await controller.history();
```

`submit()` 在 Run 启动后返回。通过 `run.result` 观察完成或失败。
`controller.isRunning` 为 `true` 时禁用冲突操作；application 和 workspace
也会检查要求空闲状态的操作。

退出时调用 `close()`。关闭会取消活动工作、拒绝未处理审批、等待事件转发结束，
随后关闭事件流。

## 投影 Application 事件

在使用项目中安装 `@may/application`、`@may/permissions` 和 `@may/tui`。
以下函数需要已打开的 controller、`TranscriptStore` 和应用提供的 `askApproval`
对话框。函数持续读取事件，直到 controller 关闭；输入和退出操作需要并发处理。

```ts
import type {
  AgentApplicationEvent,
  AgentController,
} from "@may/application";
import type {
  ApprovalDecision,
  ApprovalRequest,
} from "@may/permissions";
import { TranscriptStore } from "@may/tui/transcript";

type AskApproval = (
  request: ApprovalRequest,
) => Promise<ApprovalDecision>;

export async function projectApplication(
  controller: AgentController<AgentApplicationEvent>,
  store: TranscriptStore,
  askApproval: AskApproval,
): Promise<void> {
  store.loadHistory(await controller.history());

  for await (const event of controller.events) {
    switch (event.type) {
      case "run.event":
        store.applyMayEvent(event.event);
        break;
      case "permission.event":
        store.applyPermissionEvent(event.event);
        if (event.event.type === "approval.requested") {
          let decision: ApprovalDecision = "deny";
          try {
            decision = await askApproval(event.event.request);
          } finally {
            await controller.resolveApproval(event.event.request.id, decision);
          }
        }
        break;
      case "context.compacted":
        store.appendNotice("info", `Context compacted by ${event.strategy}`);
        break;
      case "context.compaction.failed":
        store.appendNotice("warning", event.error.message);
        break;
      case "tool.presentation":
        // 按应用声明的 kind/version 处理展示数据。
        break;
    }
  }
}
```

审批对话框失败时，`finally` 使用 `deny` 结束请求，随后传播对话框错误。请求因
取消等原因已经消失时，`resolveApproval()` 返回 `false`。

使用 `AgentWorkspaceController` 时还需要处理 `session.changed`：加载新的
`controller.history()` 后，应用后续实时事件。产品扩展事件由产品 UI 转换。

## Retained 终端渲染

Retained TUI 可以使用以下显示配置调用前面的投影函数。`application` 是已经
打开的 controller，`showApprovalDialog` 是应用提供的审批对话框。片段负责视图
生命周期；产品还需要提供输入组件和退出处理。

```ts
import {
  FullscreenRenderer,
  NodeTerminalDriver,
  TuiRuntime,
} from "@may/tui";
import { TranscriptStore, TranscriptView } from "@may/tui/transcript";

const store = new TranscriptStore();
const view = new TranscriptView(store, { assistantLabel: "My Agent" });
view.setFocused(true);

const terminal = new NodeTerminalDriver();
const renderer = new FullscreenRenderer(terminal);
const runtime = new TuiRuntime({ terminal, renderer, root: view });
const unsubscribe = store.subscribe(() => runtime.requestRender());

runtime.start();
try {
  await projectApplication(application, store, showApprovalDialog);
} finally {
  unsubscribe();
  runtime.stop();
}
```

Application 关闭后，`projectApplication()` 才会正常结束。产品通过编辑器或命令
组件调用 `submit()`；退出时调用 `application.close()`，随后等待投影任务结束。

`TranscriptView` 使用默认 registry 显示标准编码工具，未知工具使用通用显示组件。
产品显示组件注册在 `ToolRendererRegistry` 实例上，通过视图 options 传入。

Raw-mode retained TUI 使用 `NodeTerminalDriver`；逐行提示界面使用
`@may/tui/node-terminal` 的 `createNodeTerminal()`。二者管理不同输入模式，
同一终端只能由其中一个控制。

## 事件一致性

事件缓冲压力增大时，application 队列可以丢弃高频流式增量，同时保留生命周期
事件。UI 需要遵守以下规则：

- 使用完整的 `model.completed` 消息替换已经显示的增量文本；
- 将工具进度作为临时状态；
- 恢复或断线重连后重新加载 `history()`；
- 使用 `runId` 标识 Run 事件，使用调用 ID 标识工具调用；
- 显示序列化错误时不假定具体 JavaScript class。

`TranscriptStore` 实现这些实时和最终投影规则。`loadHistory()` 重建持久化事实，
恢复后的屏幕可能缺少关闭前的临时进度。
补充输入在 `input.received` 确认交付时显示到对话中。恢复历史时组合
`input.steering.queued` 和 `input.steering.delivered`，保留正文、顺序和记录标识。
等待中或者已取消的输入不会显示为已交付的对话内容；从空闲输入启动的新 Run
使用通常的 `input.submitted` 记录。

## 安全与关闭

- 清理未经过 May `Text`、Markdown 或 transcript 组件处理的终端文本；
  不可信控制序列可能篡改终端。
- 收到审批结果事件后，显示相应决定。
- 权限策略负责授权检查，界面按钮负责显示可用操作。
- 通过 UI 传输工具详情、diff 和历史页面前限制大小。
- 在 `finally` 调用 `runtime.stop()`，恢复 raw mode 和 alternate screen。
- UI 退出时移除订阅，并关闭 controller。

## 浏览器认证

`mountWebUI` 接受可选 `authentication` 对象，包含 `label`、
`login(password): Promise<string>` 和 `logout(): Promise<void>`。产品验证密码，
返回临时 UiClient 凭据，断开连接时撤销凭据。密码中的空格保留，提交后清空输入。
`connectionHint` 提供登录说明；`authentication` 与 `initialToken` 不能同时使用。
HTTP 认证与来源检查参阅[共享 Web UI](web-ui.md)。

## MCP 用户交互

MaybeCode 提供临时 `mcp.interaction.requested` / `settled` 事件、
`getMcpInteractions()` 和 `respondMcpInteraction(id, response)`。只有 UI 能在
Run 和资源准备期间同时处理这些事件时，才通过
`openConfiguredMaybeCode({ mcpInteractions: true })` 启用 broker。不要将答案排在
Session 状态队列之后。展示服务端和可信归属，校验表单并要求检查/同意，在结算或
截止时关闭提问。不自动打开浏览器，不记录表单答案历史。参阅 [MCP](./mcp.md)。


还须处理宿主拥有的 `params.mode === "review"`：`roots`、`sampling.request` 和
`sampling.response`。将有大小限制的 `data` 作为不可信内容展示。Roots 为只读；
sampling 审阅可通过 `{ action: "accept", content: { json: editedDocument } }`
提交替换 JSON，或省略 content 同意当前展示内容。不得自动批准任一 sampling 阶段。
拒绝/取消、settled/截止时间处理与表单相同。审阅不代表打开浏览器、提交 Session、
记录输入历史或执行本机工具。

## MCP 任务控制

使用 `listMcpTasks`、`getMcpTask`、`updateMcpTask`、`waitMcpTask`、`cancelMcpTask`、
`forgetMcpTask` 显式操作当前 Session 的任务。展示本地句柄及不可信有界状态，不要
自动追加到聊天。`submitMcpTask` 显式准备完成结果并启动 Run。任务输入共用上述交互
事件，重启后保留原始 owner；必须在状态转换队列之外回答。区分本地中止、远端取消
意图及已观察到的终态。重试放弃/过期输入需要显式 `retryAbandonedInputs: true`
和新审阅，不能自动重发。预算、命令和恢复限制参阅[任务](./mcp-tasks.md)。

图形 Host 可使用 `pool.openApp`、`mcpAppSandboxResponse` 和浏览器专用
`@may/mcp/apps-browser` 入口。同意、origin/CSP 要求和不支持的 API 参阅
[隔离 Apps](./mcp-apps.md)；终端保留文本显示。

## 验证 UI 生命周期

使用真实 controller 和持久化后端，确认完整响应替换部分文本、其他界面的审批
结果使当前提示关闭、取消移除活动控件、Session 切换加载对应历史，以及退出清理
事件订阅和终端资源。

相关宿主职责参阅[权限策略](permission-policy.md)、[自定义工具](custom-tool.md)
和[Runtime 与 Session 边界](../architecture/runtime-session.md)。
