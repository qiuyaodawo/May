# 权限策略

[English](../../guides/permission-policy.md) | **简体中文**

`@may/permissions` 是包围工具执行的 headless 授权与审批层。`PermissionPolicy` 接收
工具定义、已解析输入和 execution correlation data，然后返回：

- `allow` —— 立即执行；
- `deny` —— 拒绝调用；
- `ask` —— 暂停，等待一次性审批；
- `{ decision: "ask", grantKey }` —— 暂停，并允许 UI 选择 `allow-session` 后建立
  内存 scope grant。

权限与工具分离，使同一个 capability 可以用于不同产品策略。

## 默认拒绝策略

保持 allow rule 狭窄，并使用由策略定义的稳定 grant key：

```ts
import type { PermissionPolicy } from "@may/permissions";

export const permissionPolicy: PermissionPolicy = ({ tool, input }) => {
  // 对本产品安全的纯、有限操作。
  if (tool.name === "add") return "allow";

  // 对一个规范化 notification channel 请求审批。
  if (tool.name === "send_notification") {
    const channel = stringField(input, "channel")?.trim().toLowerCase();
    if (channel === undefined || channel === "") return "deny";
    return {
      decision: "ask",
      grantKey: `send_notification:channel:${channel}`,
    };
  }

  // 新工具不会仅因被注册就自动获得授权。
  return "deny";
};

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}
```

策略在 `Tool.parse()` 后执行，通常收到已校验输入，但必要授权字段缺失时仍应 fail
closed。`inputSchema` 本身不是 runtime validation。

Grant key 是授权 scope，不是显示标签。只想授权单个文件或目录时，不要使用 `write`
之类过宽 key。若 raw JSON 中无关的顺序或 secret 字段会导致 key 不稳定或泄露，也不应
直接使用它。

## 审批协议

`AgentApplication` 把审批请求转发为 `permission.event`。UI 选择决定，再通过
controller 返回：

```ts
import type { AgentApplication } from "@may/application";
import type {
  ApprovalDecision,
  ApprovalRequest,
} from "@may/permissions";

type Choose = (request: ApprovalRequest) => Promise<ApprovalDecision>;

export async function serveApprovals(
  application: AgentApplication,
  choose: Choose,
): Promise<void> {
  for await (const event of application.events) {
    if (
      event.type !== "permission.event" ||
      event.event.type !== "approval.requested"
    ) {
      continue;
    }

    const request = event.event.request;
    let decision: ApprovalDecision = "deny";
    try {
      decision = await choose(request);
    } finally {
      await application.resolveApproval(request.id, decision);
    }
  }
}
```

只有 `request.grantKey` 存在时才展示 `allow-session`。没有 key 却处理为
`allow-session` 会抛错。未知或已取消请求会让 `resolveApproval()` 返回 `false`，UI
可据此关闭过期 dialog。

未处理请求会一直等待，直到 Run 被取消或 permission executor/application 关闭。UI
必须提供明确 deny/cancel 路径；当前没有隐式审批 timeout。

## Grant 生命周期

Session grant 存在于一个 `PermissionToolExecutor` 实例。每次调用都会先评估 policy，
再检查已存 grant，因此后续 `deny` 仍优先。匹配 scope grant 只跳过审批 prompt。

`AgentApplication` 为活动 Session 创建一个 executor，关闭时清除。当前 grant 不持久化：
重新打开或恢复 Session 会新建 executor，并再次要求审批。除非产品有意跨 Session
共享 grant，否则不要共享原始 executor。

直接使用 `PermissionToolExecutor` 时，用 `revokeSessionGrant(grantKey)` 移除 scope，
用 `close()` 取消待处理请求。若应用不通过 `AgentApplication` 自行组装 Session 和
permission，应将 `setEventSink()` 连接到 `Session.recordPermissionEvent()`。

## 失败语义

- `deny` 产生 `PermissionDeniedError`，记录为失败 tool result，模型可以处理。
- Policy 异常或 approval-event 持久化失败会成为 fatal tool execution error 并结束 Run。
- 取消 Run 会取消待处理 request 并发出 `approval.cancelled`。
- 关闭 application 会拒绝所有待处理 request 并关闭 event stream。

不要捕获 policy failure 后默认 `allow`。外部 policy service 不可用时，应明确 deny 或
让 Run 失败。

## 安全边界

Permission 回答工具**是否**可以执行，不限制执行后进程**能够影响什么**：

- `allow` 与已审批调用仍使用工具的 OS/network credential；
- path grant 不会自动防御 symbolic link，工具必须自行校验 filesystem boundary；
- command preview 是显示 metadata，不证明实际执行效果相同；
- approval event 与输入可能包含敏感数据，并由 `AgentApplication` Session history 持久化。

应进行纵深防御：狭窄工具 API、严格解析、最小权限 credential、资源限制、安全的
workspace 文件处理，以及执行不可信代码时使用外部 sandbox。May 当前权限层既不是
sandbox，也不是持久化的组织级 policy service。

参阅[自定义工具](custom-tool.md)和[自定义 UI](custom-ui.md)。
