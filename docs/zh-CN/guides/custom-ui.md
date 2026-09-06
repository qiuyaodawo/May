# 自定义 UI

[English](../../en/guides/custom-ui.md) | **简体中文**

May 的 application 层是 headless 的。终端、桌面、Web 或远程 UI 应依赖
`AgentController`（一个活动 Session）或 `AgentWorkspaceController`（多个 Session），
调用表达用户意图的方法，并把异步 event stream 投影为 view state。

不要把 UI 状态作为事实来源。完整 Session event 会持久化；streaming delta 和 progress
只是实时观察。

## Headless Controller 边界

主要 UI 操作为：

```ts
const run = await controller.submit({ input: "Explain this repository" });
run.cancel("Cancelled in UI");        // 取消此 handle
controller.cancel("Cancelled in UI"); // 取消活动 Run 或压缩

await controller.resolveApproval(requestId, "allow");
await controller.compactContext();
const history = await controller.history();
```

`submit()` 在 Run 启动时 resolve，不等 Run 完成。通过 `run.result` 观察完成或失败。
`controller.isRunning` 为 true 时禁用冲突 control；application 与 workspace 方法也会
强制执行 idle-only transition。

始终调用 `close()`。关闭会取消活动工作、拒绝未处理审批、等待事件 relay，再关闭
event stream。

## 投影 Application Event

下列 bridge 填充 `@may/tui` 的可复用 transcript，同时不让 controller 耦合终端输入：

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
        // 应用拥有带 namespace/version 的显示 schema。
        // 在这里解码已识别 kind，并更新对应 tool item。
        break;
    }
  }
}
```

若 approval dialog 失败，此例会 deny，而不是让 Run 永久暂停。请求已经因取消等原因
消失时，`resolveApproval()` 返回 `false`。

对 `AgentWorkspaceController` 还要处理 `session.changed`：先重置或加载新的
`controller.history()`，再应用后续实时事件。产品 extension event 也由产品 UI bridge
转换。

## Retained 终端渲染

`@may/tui` 提供终端基础组件，但图形 UI 不必依赖它。最小 retained transcript：

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

Application 必须关闭，`projectApplication()` 才会正常结束。真实产品中由 editor 或
command component 发起 `submit()`；退出路径先调用 `application.close()`，再等待
projection task。

`TranscriptView` 使用默认 registry 渲染标准编码工具，未知工具使用通用 renderer。
产品 renderer 注册在 `ToolRendererRegistry` 实例上，再通过 view option 传入；不存在
全局 UI registry。

Raw-mode retained screen 使用 `NodeTerminalDriver`；行式 prompt UI 使用
`@may/tui/node-terminal` 的 `createNodeTerminal()`。二者拥有不同 input mode，不能同时
控制同一个 terminal。

## 事件一致性

Buffer 压力下 application queue 可以丢弃高频 streaming delta，但保留 lifecycle
event。因此 UI 必须：

- 用完整 `model.completed` message 替换 streamed assistant text；
- 把 tool progress 视为临时状态；
- 恢复或断线重连后重新加载 `history()`；
- 用 `runId` 标识 Run event，用 call ID 标识 tool call，不能靠到达文本；
- 渲染序列化错误时不假定具体 JavaScript class。

`TranscriptStore` 实现这些实时/最终投影规则。`loadHistory()` 只重建持久化事实，因此
恢复后的屏幕可能有意忽略关机前见过的临时 progress。

## 安全与关闭

- 对不经过 May `Text`、Markdown 或 transcript component 渲染的终端文本做清理；
  不可信控制序列可能篡改终端。
- 观察到 resolution event 前，不要把审批显示为已允许。
- 不能从 disabled button 推断授权；permission policy 才是 enforcement boundary。
- 通过 UI transport 发送工具细节、diff 和 history page 前限制大小。
- 在 `finally` 调用 `runtime.stop()`，恢复 raw mode 和 alternate screen。
- UI 退出时移除 subscription，并关闭 controller。

参阅[权限策略](permission-policy.md)、[自定义工具](custom-tool.md)和
[Runtime 与 Session 边界](../architecture/runtime-session.md)。

### MCP 用户交互

MaybeCode 提供临时 `mcp.interaction.requested` / `settled` 事件、
`getMcpInteractions()` 和 `respondMcpInteraction(id, response)`。只有 UI 能在
Run 和资源准备期间同时处理这些事件时，才通过
`openConfiguredMaybeCode({ mcpInteractions: true })` 启用 broker。不要将答案排在
Session 状态队列之后。展示服务端和可信归属，校验表单并要求检查/同意，在结算或
截止时关闭提问。不自动打开浏览器，不记录表单答案历史。参阅 [MCP](./mcp.md)。
