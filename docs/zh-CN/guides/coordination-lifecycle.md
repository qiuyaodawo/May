# 执行尝试与任务图修订

[English](../../en/guides/coordination-lifecycle.md) | **简体中文**

使用 `retryTask()`，可以在核查失败任务后授权新的执行尝试；使用 `rewriteGraph()`，
可以修改尚未提交输入的后续任务。这两项操作由宿主调用，分别需要明确的策略回调。

本指南要求已有[协作运行时](coordination.md)、持久 Session 记录，以及核查外部任务
结果的权限。创建任务图时配置相应回调，恢复时提供相同的策略版本。

## 授权新的执行尝试

1. 在传给 `CoordinationRuntime.create()` 或 `resume()` 的策略中加入
   `authorizeRetry`。以下策略允许宿主记录核查结论后重试 `analyst` 角色：

```ts
import type { CoordinationPolicy } from "@may/coordination";

const policy: CoordinationPolicy = {
  version: "team-policy-v2",
  authorize: (task) => task.agent === "analyst",
  authorizeRetry: (task, finding) =>
    ["failed", "cancelled"].includes(task.status) && finding.trim().length > 0,
};
```

2. 核查任务、任务拥有的后代和外部影响。状态为 `recovery-required` 时，
   根据证据调用 `resolveRecovery()`，随后才可以申请重试。
3. 使用唯一命令 ID 和实际核查结论调用 `retryTask()`，在 `wait()` 返回后
   检查新尝试的状态：

```ts
await runtime.retryTask(
  "retry-analysis-1",
  "analysis",
  "已确认 provider 在产生任何工具副作用前拒绝了请求，允许新的执行尝试。",
);
const snapshot = await runtime.wait();
console.log(snapshot.tasks.find((task) => task.id === "analysis"));
```

`retryTask(commandId, taskId, finding)` 只接受已知 `failed` 或 `cancelled` 的任务。
`recovery-required` 任务必须先根据可靠证据调用 `resolveRecovery()` 完成人工核实。
核实操作只记录结论，不执行任务。重试策略会在实际调度前再次检查。

新尝试保留逻辑任务 id、输入、静态依赖和父任务，分配新的 Session 与 dispatch id，
增加 `attempt`（初始为 0），并向 `attempts` 追加不可变的上一尝试终态快照。
每条记录包含已接受的命令 id、宿主核实结论，以及旧控制者、handoff 和输出证据。
旧 Session 历史既不修改，也不重新提交。新 Session 只接收原任务、显式依赖结果和标记为
数据的诊断摘要，不继承旧对话或工具审批授权。

任务全局 `turn` 延续原来的计数并继续递增，旧邮箱凭据保持明确的轮次身份。`maxTaskTurns`（默认 16）、
`maxHandoffs`（默认 4）、任务总数、消息总数和协作截止时间均为整个生命周期的限制。
`maxAttempts`（默认 3）包括初始尝试。新尝试不会回滚文件、远程副作用或已使用额度；
共享预算继续计算新的调用。

以下情况会拒绝重试：

- 本任务或它拥有的后代仍在执行，或存在未知结果。
- 父任务已经预留该子任务的结果，或静态下游已经提交输入。
- 存在尚未投递的消息，可能跨入新尝试。
- 被委派任务的父任务不再处于等待状态。
- 协作已停止、超时，或没有剩余轮数、尝试次数。

重试上游不会顺带重试下游。仅因上游失败而未运行的下游，可以在上游成功后单独重试，
但也需要另一条显式授权命令。已完成的任务不可重试。

使用相同命令 id 与结论重复调用不会重复执行；改变内容会被拒绝。如果重试提交的确认
结果不明确，应关闭并恢复运行时。持久化状态会标识新尝试，不会重放旧尝试。
恢复时，历史控制者对应的 worker/agent 版本仍需保留在注册表中。

外部执行适配器可以实现 `cancel(execution)`，取消已脱离本地执行 Promise 的工作。
协调器先持久化取消意图，再发送这一幂等控制请求；父任务级联、截止时间和关闭运行时
都会处理这类工作。取消请求投递失败时保持 `recovery-required`；收到确认本身不等于
已经确认执行结果。重复宿主取消命令可以重试投递，但不会重新执行任务。

## 原子修订未来的任务节点

1. 创建运行时时，在策略中加入 `authorizeGraphRewrite`。以下片段使用前文
   导入的 `CoordinationPolicy`：

```ts
const authorizeGraphRewrite: NonNullable<CoordinationPolicy["authorizeGraphRewrite"]> = (change, snapshot) =>
  snapshot.tasks.length < 128 &&
  [...(change.add ?? []), ...(change.update ?? [])].every(
    (task) => task.agent === "analyst",
  );
const graphPolicy: CoordinationPolicy = { ...policy, authorizeGraphRewrite };
```

将 `graphPolicy` 作为 runtime 的 `policy` 选项传入。

2. 确认要修改的顶层任务仍在排队，且从未提交输入。以下示例要求已经存在
   `first`、`summary` 和 `unused-check`，其中 `summary` 和 `unused-check`
   仍然符合修改条件。
3. 使用唯一命令 ID 提交完整修改：

```ts
await runtime.rewriteGraph("expand-plan-1", {
  add: [
    { id: "second-check", agent: "analyst", input: "核查第一次检查的结果。", dependsOn: ["first"] },
  ],
  update: [
    { id: "summary", agent: "analyst", input: "汇总两次检查。", dependsOn: ["first", "second-check"] },
  ],
  remove: ["unused-check"],
});
```

`TaskGraphChange` 接受 `add`、`update` 和 `remove` 数组。更新项必须提供完整的
`TaskSpec`。同一个任务 id 不能在一次编辑中重复出现。所有修改节点、依赖、环路、配额
和最终完整任务图均通过检查后，才执行一次持久化提交。新增和更新节点还必须通过通用
任务授权，并在实际调度时再次授权。

只有全新、排队中的顶层节点可更新或删除。它们不得提交过输入、预留过收件箱、参与过
委派、拥有子任务、等待、移交或重试。适配器的只读恢复检查必须确认 `not-started`；
邮箱、所有权和唤醒引用也会阻止修改。运行中、等待中、终态或结果未知的任务不可改写。
若部分工作已经开始，可以新增依赖既有完成结果的节点，只修改剩余的全新节点。

替换节点会分配新的 Session/dispatch 身份。`graphChanges` 记录每次已接受的编辑与完整
旧节点快照。已删除 id 不可复用，任务图编辑和动态委派都不能重新使用它。
整个生命周期的 `maxTasks` 配额计算当前节点和已删除节点。`maxGraphChanges` 默认 32，
每次编辑的操作总数由 `maxTasks` 限制。编辑不会重置截止时间或预算。

命令返回后，检查 `runtime.snapshot().graphChanges` 和新的任务定义，随后启动或
继续调度符合条件的排队任务。已经产生执行证据的工作需要调整时，使用新的任务 ID。
