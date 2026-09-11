# 多 Agent 任务的共享资源

[English](../../en/guides/coordination-resources.md) | **简体中文**

[协作运行时](coordination.md) 负责调度任务。三个可选的宿主组件分别管理共享用量、
显式产物和隔离的文件副本。它们不增加 Agent 的执行权限，也不替代工具权限控制。

## 共享模型预算

```ts
import { FileSharedBudget } from "@may/coordination";

const budget = await FileSharedBudget.open(budgetDirectory, coordinationId, {
  maxModelCalls: 32,
  maxTotalTokens: 262_144,
  // 可选费用统计，必须明确指定当前 provider/model 的价格。
  maxCostUsd: 2,
  tokenPrices: { inputUsdPerMillion: 1, outputUsdPerMillion: 4 },
});
const meteredModel = budget.wrapModel(providerModel, {
  reservation: { totalTokens: 32_768, costUsd: 0.15 },
});
// 团队所有 Agent definition 使用的模型均接入同一个预算。
// 所有 Run 停止后：
console.log(await budget.totals());
await budget.close();
```

`providerModel`、`budgetDirectory` 和 `coordinationId` 由可信宿主传入。
示例价格仅用于说明，不代表当前 provider 定价。预留值是宿主选择的用量上界估计，
不是设置 provider token 上限的 API。应单独配置 provider 输出上限，并按最大预期
输入加输出设置预留值。不同 provider/价格需使用独立账本，或由宿主适配器统一正确
计费；一个账本只使用一份固定价格表。

每次请求模型前，包装器持久化预留一次调用及指定 token/费用容量。并发请求不能
重复占用同一份剩余额度。完成后按 provider 返回用量结算并释放未使用部分，
**随后**才向 Agent 工具步骤暴露 `response.completed`。调用身份使用 May 的稳定
`modelCallId`；已预留的 id 不会自动重放。

- 必须在**物理 provider 请求边界**计费，即位于重试包装器内部，或关闭隐藏重试。
  外层包装器无法统计内部不透明的多次请求。同一调用身份的自动重试会被拒绝，
  不能当成免费请求。
- 不透传 provider 原生上下文压缩能力，因为其隐藏请求及缺失用量会绕过计费。
  若宿主启用另一个摘要模型，也应接入同一账本。
- 用量缺失/无效、流中断、重启后仍未结算的预留都会阻止新请求。
  实际用量超出预留也会阻止结果进入工具步骤，并阻止后续请求。
- `reconcile(callId, verifiedUsage, evidence)` 仅记录宿主核实后的未知用量或预留
  超额结算，不请求 provider、不恢复工具，也不替代 Session 自身的恢复判断。
  任务失败、yield、handoff 或重试都不会自动退还已经消耗的用量。
- 响应边界检查无法撤回 provider 已发生费用，也不能停止其他已在途请求。
  这是持久化的准入与统计上限，**不是外部账单硬上限**；宿主仍需合理配置
  预留和 provider 限制。

`snapshot()` 返回调用凭据；`totals()` 包含尚未结算的预留。原有单 Run 预算保持
独立，可进一步限制每次 Run。重开账本时限制和价格必须一致。调用 `close()` 前
先停止活动模型请求；组件不会自动抢占旧锁。

## 不可变产物

```ts
import { FileArtifactStore } from "@may/coordination";

const artifacts = await FileArtifactStore.open(artifactDirectory, coordinationId, {
  policyVersion: "review-team-v1",
  authorizeRead: (requester, artifact) =>
    requester === "manager" && artifact.ownerTaskId === "worker",
});
const workerArtifacts = artifacts.forTask("worker");
const reference = await workerArtifacts.publish("dispatch-1:turn-0:final", {
  name: "analysis.md",
  mimeType: "text/markdown",
  text: "显式任务结果，不包含隐藏推理或凭据。",
});
const result = await artifacts.forTask("manager").read(reference.id);
// 或者在任务 Agent definition 中显式加入 workerArtifacts.tools()。
await artifacts.close();
```

产物包含有大小限制的 UTF-8 文本及不可变元数据：id、所属任务、名称、MIME 类型、
字节数和 SHA-256。id 与存储路径由宿主生成，名称不是文件系统路径。任务可以读取
自己的产物；读取其他任务产物默认拒绝，除非宿主 ACL 返回 `true`。知道 id 不等于授权。

`publish_artifact` 与 `read_artifact` 使用宿主提供的任务绑定，模型不能指定所属任务。
同一个持久化命令只允许用相同内容再次确认。发布先写入并同步不可变 blob，随后
确认日志记录。读取检查大小、文件类型与哈希；被修改的字节或链接会被拒绝。
未完整写入、未被日志引用的 blob 不会被静默覆盖。

默认限制：256 个产物、单个 1 MiB、总计 16 MiB。重开时限制和 ACL 版本必须一致。
`snapshot()` 向宿主返回引用，不是模型目录工具，也不是绕过 ACL 的工具。
每个 dispatch/turn 的结果应使用不同命令 id。通过消息或答案显式传递产物 id，
组件不会向所有 Agent 上下文自动注入内容。产物内容仍是不可信任务数据。

## 任务工作区副本

```ts
import { TaskWorkspaceManager } from "@may/coordination";

const workspaces = await TaskWorkspaceManager.open({
  sourceDirectory: userCheckout,
  directory: privateTeamDirectory, // 不能与用户工作区重叠。
});
const workspace = await workspaces.prepare(task.id);
// 将该任务文件工具绑定到 workspace.directory，而不是 userCheckout。
const changes = await workspaces.changes(task.id);
// 展示差异供审阅；应用选中的补丁是独立的用户/宿主动作。
await workspaces.close();
```

管理器先建立过滤后的团队基线，再为每个逻辑任务建立独立的普通文件副本。
即使源目录随后发生改变，所有任务也使用相同初始基线。相同任务的后续 turn、
handoff 和显式重试保留其副本，不自动回滚。用户 checkout 始终不被修改；
没有自动 Git 操作、合并、删除或回写。

默认限制：单份快照最多 10,000 个文件、64 MiB，最多 128 个任务副本。默认排除
所有隐藏名称、依赖/构建/缓存/数据目录、常见凭据名称和密钥/证书文件。
`excludeNames` 只能增加排除项，不能移除内置规则。符号链接/junction 和非普通
文件会被跳过。这是保守的名称过滤，**不是秘密检测**；仍应检查交给 Agent 的
普通文件是否包含敏感信息。不保留可执行权限元数据和依赖，因此不是开箱即用的
构建环境镜像。

`changes()` 返回有数量/大小限制的普通文件新增、修改、删除及哈希，供审阅。
宿主需在其他位置显式审阅并应用选中修改；管理器不提供合并 API。中断的基线或
任务副本保持隔离，不会被静默替换。手动清理前应检查相应私有目录。

文件副本隔离**不是进程沙箱**，不能阻止 shell、网络客户端或无限制工具访问
其他路径或凭据。基线和资源账本应放在任务工具根目录之外；执行不可信代码时，
还需使用限定作用域的文件工具、显式权限以及真正的操作系统/容器沙箱。

## 持久化与所有权

每个存储都是单写者本地日志，确认前先同步到磁盘。可修复未结束的最后一条 JSONL
记录；完整记录损坏、配置变化和写入结果不确定时停止继续执行。可能仍有活动
持有者时不要删除锁文件。这些组件不实现分布式锁，也不会自动恢复过期锁。
应先关闭协作运行时并等待活动任务结束，再关闭资源存储。
