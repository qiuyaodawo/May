# 配置工具权限与审批

[English](../../en/guides/permission-policy.md) | **简体中文**

本文指导应用配置直接执行、需要审批以及能够跨重启保留的授权。
将 `@may/permissions` 加入应用直接依赖，在配置策略前完成工具输入校验。
应用与事件消费者见[构建 Agent](building-an-agent.md)。

`PermissionPolicy` 接收工具定义、已解析输入和执行标识，返回值决定授权行为：

- `allow` —— 立即执行；
- `deny` —— 拒绝调用；
- `ask` —— 暂停，等待一次性审批；
- `{ decision: "ask", grantKey }` —— 暂停，并允许 UI 选择 `allow-session` 后建立
  内存 scope grant；
- `{ decision, grantKey, persistent: { scopeId, description } }` —— 为 `allow`、
  `deny` 或 `ask` 指定可信的持久授权范围；`ask` 配置规则存储后，UI 可以提供
  `allow-persistent`；
- `ask` 指定 `requireApproval: true` —— 每次请求一次性审批，同时检查持久禁止规则。

权限与工具分离，使同一个 capability 可以用于不同产品策略。

## 默认拒绝策略

创建策略模块，明确允许的操作范围。以下示例要求已经注册 `add` 和
`send_notification` 工具：

```ts
import type { PermissionPolicy } from "@may/permissions";

export const permissionPolicy: PermissionPolicy = ({ tool, input }) => {
  // 允许本产品支持的有限加法操作。
  if (tool.name === "add") return "allow";

  // 为指定通知渠道请求审批。
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

策略在 `Tool.parse()` 后执行，通常收到已校验输入。必要授权字段缺失时应立即拒绝。
工具需要通过 `Tool.parse()` 或执行入口校验输入。

Grant key 表示授权范围。授权单个文件或目录时，使用能够区分该资源的稳定 key。
避免在 key 中保存凭据、文件内容或包含敏感字段的 raw JSON。

## 审批协议

`AgentApplication` 将审批请求转发为 `permission.event`。
在应用现有事件消费者中加入审批处理。以下函数仅展示审批部分，宿主提供 `choose`
和已经认证的 `createdBy` 身份。完整 UI 需要在同一消费者中处理其他事件，
或明确分发到独立队列：

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
  createdBy: string,
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
      await application.resolveApproval(
        request.id,
        decision,
        decision === "allow-persistent" ? { createdBy } : undefined,
      );
    }
  }
}
```

只有 `request.grantKey` 存在时才展示 `allow-session`。只有 `request.persistent`
存在时才展示 `allow-persistent`，并展示完整的 `description`。持久授权的 `createdBy`
由宿主通过已经认证的用户身份提供；宿主必须验证身份来源。可选 `expiresAt` 使用未来的
epoch milliseconds。无效选择会抛出异常。未知、正在处理或已经取消的请求会让
`resolveApproval()` 返回 `false`，UI 可以关闭对应 dialog。

未处理请求会一直等待，直到 Run 被取消或 permission executor/application 关闭。UI
必须提供明确 deny/cancel 路径；当前没有隐式审批 timeout。

## 持久授权范围与存储

以下组合片段需要已经注册的 `write_documentation` 工具校验项目 Markdown 路径，
并由宿主提供可信的 `projectDirectory`、`projectIdentity`、`userIdentity` 和 `agentIdentity`：

```ts
import { join } from "node:path";
import { PermissionToolExecutor } from "@may/permissions";
import { FilePermissionRuleStore } from "@may/permissions/file-store";

const ruleStore = await FilePermissionRuleStore.open({
  path: join(projectDirectory, ".may", "permission-rules.json"),
});
const permissions = new PermissionToolExecutor({
  ruleStore,
  policy({ tool }) {
    if (tool.name !== "write_documentation") return "deny";
    // 宿主提供可信身份；write_documentation 校验 docs 中的 Markdown 路径。
    return {
      decision: "ask",
      grantKey: "docs-markdown:v1",
      persistent: {
        scopeId: JSON.stringify([projectIdentity, userIdentity, agentIdentity]),
        description: "允许当前 Agent 修改项目 docs 目录中的 Markdown 文件",
      },
    };
  },
});
```

宿主负责身份来源和资源范围校验。稳定的 `scopeId` 必须区分所需的用户、项目和 Agent。
`grantKey` 表示经过校验、能够共用授权的一类操作，`description` 向用户完整描述范围。
这些字段应仅包含必要身份与操作信息。文件策略和工具必须检查真实文件系统路径、项目边界
以及目录链接，再允许目录范围的授权。

宿主指定存储位置。本地项目可以使用 `<project>/.may/permission-rules.json`，
并将个人授权文件加入 `.gitignore`。长期运行的宿主可以使用
`<data-directory>/permission-rules.json`，通过 `scopeId` 区分用户、项目和 Agent。
默认入口提供 `InMemoryPermissionRuleStore`。数据库实现可以提供 `PermissionRuleStore`
规定的异步 `list(scopeId?)`、`create(rule)`、`revoke(id)` 方法。

每条 `PersistentPermissionRule` 保存 `id`、`scopeId`、`toolName`、`definitionKey`、
`grantKey`、`description`、`decision`、`createdAt`、`createdBy` 和可选 `expiresAt`。
规则仅保存授权信息，原始工具参数通过运行记录管理。
`permissionDefinitionKey(tool)` 根据工具 name、description、`inputSchema` 和可选的宿主
`permissionVersion` 生成规范化 identity；等价 Schema 的属性顺序变化能够保留相同 identity。
操作范围、账号、输出含义或其他影响授权的行为变化时，宿主必须更新 `permissionVersion`。
工具定义变化后，已有授权无法继续匹配。

每次相关权限检查都会评估 policy 并读取配置的规则存储。Policy 返回 `deny` 时立即拒绝。
有效的持久禁止规则优先于 policy 的 `allow`、持久允许规则和 Session grant。
持久允许规则需要同时匹配 scope、grant key、工具名称、完整定义和有效期，才能满足 `ask`。
在 `ask` 上设置 `requireApproval: true` 后，每次需要一次性审批，请求不提供 `grantKey`
或持久授权信息。

处理 `allow-persistent` 时，executor 保存规则，并等待权限事件保存完成后执行工具。
审批等待和规则使用事件结束后，会重新检查当前 policy 与规则。范围变化、撤销、过期或
新增禁止规则都会阻止复用已有审批。撤销影响后续检查；已经执行的工具继续使用当前取消机制。

## 宿主规则管理

`PermissionToolExecutor` 提供受信任的管理方法：

- `createRule(check, { decision, createdBy, expiresAt? })`：对不可变的 `PermissionCheck`
  重新调用当前 policy，使用可信范围保存允许或禁止规则。创建允许规则需要 policy 允许持久授权。
- `createRuleFrom(sourceId, options)`：使用存储中现有规则的可信范围，创建新的允许或禁止规则，
  并生成新的 identifier、创建时间、审批用户和可选有效期。该操作仅接受来源 identifier 和管理选项。
- `listRules(scopeId?)`：列举保存的规则，包含过期规则，供用户检查。
- `revokeRule(id)`：删除规则，返回该规则是否存在。

Application 对应方法为 `createPermissionRule`、`createPermissionRuleFrom`、
`listPermissionRules` 和 `revokePermissionRule`。这些方法用于已经认证的宿主管理操作。
Agent 工具必须通过宿主审批管理授权。拒绝一次审批仅拒绝当前调用；保存持久禁止规则需要
用户明确选择管理操作。

`FilePermissionRuleStore.open({ path })` 校验带有版本的 JSON 文件，初始化不存在的文件，
并取得独占的 `<path>.lock`。Store 按顺序处理操作，每次读取当前文件内容，通过写入并同步
临时文件后原子替换规则文件。Node.js 支持目录同步的平台也会同步父目录。
不支持的数据格式、目录链接和具有多个链接的文件会导致校验失败。读取或写入失败后，
该 store 实例停止后续存储操作。

一个路径由一个 file store 持有。同一个本地进程中的 executor 可以共用该 store。
宿主关闭相关 executor 后调用 `await ruleStore.close()`，释放写入锁。
Executor 的 `close()` 保持注入 store 的宿主管理关系。已有写入锁会阻止第二个 owner 打开文件。
进程异常结束并保留锁文件时，宿主需要检查其中的 PID/hostname，再手动清理；store 保留已有锁文件。

## Grant 生命周期

Session grant 存在于一个 `PermissionToolExecutor` 实例，绑定 grant key、完整工具定义
和可选持久 `scopeId`。匹配 scope grant 可以跳过审批 prompt，同时保持 policy 和禁止规则检查。

`AgentApplication` 为活动 Session 创建一个 executor，关闭时清除 Session grant。
重新打开 Session 会创建新的 executor。配置的持久规则可以跨 executor 和程序重启继续使用。
产品决定共用 Session grant 时，可以共用对应 executor。

直接使用 `PermissionToolExecutor` 时，用 `revokeSessionGrant(grantKey)` 移除该 Session
grant key 下全部工具定义和持久 scope，
用 `close()` 取消待处理请求。若应用不通过 `AgentApplication` 自行组装 Session 和
permission，应将 `setEventSink()` 连接到 `Session.recordPermissionEvent()`。

## 失败语义

`PermissionToolExecutor({ beforeCheck })` 在每次工具执行时，根据不可变的检查数据
调用一次预览准备方法。审批后重新检查策略，或记录规则使用事件后重新检查策略，
都不会再次调用该方法。宿主规则管理操作也不会调用它。
`AgentApplication` 通过该方法运行 `createToolPresentation`，准备失败会终止操作。

- `deny` 产生 `PermissionDeniedError`，记录为失败 tool result，模型可以处理。
- Policy 异常、规则存储读取/校验/写入失败或权限事件保存失败，会成为 fatal tool execution
  error 并结束 Run。
- 取消 Run 会取消待处理 request 并发出 `approval.cancelled`。
- 关闭 application 会拒绝所有待处理 request 并关闭 event stream。
- 规则保存成功后，后续事件失败或当前 Run 取消时，规则仍然保留。宿主可以检查和撤销。

权限事件包含 `rule.created { rule }`、`rule.revoked { ruleId, scopeId }` 和
`rule.used { ruleId, scopeId, decision, runId, toolCallId }`，每个事件带有 `seq` 和
`timestamp`。Executor 等待 sink 完成后继续执行。Session 保存事件；规则恢复读取配置的
store。待处理审批继续使用 Session 恢复机制。

不要捕获 policy failure 后默认 `allow`。外部 policy service 不可用时，应明确 deny 或
让 Run 失败。

## 验证持久审批

MaybeCode 的真实 Provider 验证需要显式启用。运行 `pnpm build` 后设置
`MAYBECODE_PERSISTENT_RULES_LIVE=1`，可以通过
`MAYBECODE_PERSISTENT_RULES_MODEL=<configured-profile>` 选择已有模型配置，然后运行
`node --test apps/maybecode/test/integration/persistent-rules.test.mjs`。
测试通过当前用户配置调用真实 Provider，两次写入同一个独立文件，并在两次请求之间
关闭和重新打开 Session 与 executor。验证内容包括一次持久审批、历史中的规则创建
和使用证据，以及模型 Context 中没有权限记录。每个 Run 最多调用模型三次，时限
45 秒；关闭 retries、Git、MCP、Skills、Goals 和子 Agent。证据保存在被忽略的
`review/persistent-rules` 目录；常规离线运行跳过这一测试。

## 安全边界

权限决定工具**是否**可以执行，进程能够影响的资源由执行环境限制：

- `allow` 与已审批调用仍使用工具的 OS/network credential；
- path grant 不会自动防御 symbolic link，工具必须自行校验 filesystem boundary；
- command preview 是显示 metadata，不证明实际执行效果相同；
- approval event 与输入可能包含敏感数据，并由 `AgentApplication` Session history 持久化。

应进行纵深防御：狭窄工具 API、严格解析、最小权限 credential、资源限制、安全的
workspace 文件处理，以及执行不可信代码时使用外部 sandbox。宿主负责配置 sandbox
和组织级 policy service。

参阅[自定义工具](custom-tool.md)和[自定义 UI](custom-ui.md)。

宿主工具版本管理详见[每次 Run 的动态目录](./custom-tool.md)。
