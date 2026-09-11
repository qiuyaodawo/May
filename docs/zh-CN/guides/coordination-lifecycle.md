# 执行尝试与任务图修订

[English](../../en/guides/coordination-lifecycle.md) | **简体中文**

[协作运行时](coordination.md) 提供两个仅供宿主调用的生命周期操作：显式创建新执行尝试，
以及原子编辑尚未提交输入的任务节点。二者都不是自动重试策略，也不会作为 Agent 工具开放。
二者需要独立的宿主授权；未提供对应策略回调时默认拒绝。

## 授权新的执行尝试

```ts
const policy = {
  version: "team-policy-v2",
  authorize: (task) => task.agent === "analyst",
  authorizeRetry: (task, finding) =>
    ["failed", "cancelled"].includes(task.status) && finding.trim().length > 0,
};

// 宿主必须真正核实该结论；填写这段文本不等于完成验证。
await runtime.retryTask(
  "retry-analysis-1",
  "analysis",
  "已确认 provider 在产生任何工具副作用前拒绝了请求，允许新的执行尝试。",
);
const snapshot = await runtime.wait();
```

`retryTask(commandId, taskId, finding)` 只接受已知 `failed` 或 `cancelled` 的任务。
`recovery-required` 任务必须先根据可靠证据调用 `resolveRecovery()` 完成人工核实。
核实操作只记录结论，不执行任务。重试策略会在实际调度前再次检查。

新尝试保留逻辑任务 id、输入、静态依赖和父任务，分配新的 Session 与 dispatch id，
增加 `attempt`（初始为 0），并向 `attempts` 追加不可变的上一尝试终态快照。
每条记录包含已接受的命令 id、宿主核实结论，以及旧控制者、handoff 和输出证据。
旧 Session 历史既不修改，也不重新提交。新 Session 只接收原任务、显式依赖结果和标记为
数据的诊断摘要，不继承旧对话或工具审批授权。

任务全局 `turn` 递增而不重置，旧邮箱凭据不会产生歧义。`maxTaskTurns`（默认 16）、
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

```ts
// 创建或恢复运行时时，将此回调加入 policy。
const authorizeGraphRewrite = (change, snapshot) =>
  snapshot.tasks.length < 128 &&
  [...(change.add ?? []), ...(change.update ?? [])].every(
    (task) => task.agent === "analyst",
  );

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

`TaskGraphChange` 接受 `add`、`update` 和 `remove` 数组。更新项是完整的 `TaskSpec`，
不是局部补丁。同一个任务 id 不能在一次编辑中重复出现。所有修改节点、依赖、环路、配额
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

这些限制刻意排除了对运行中流程的任意改写。活动协作应使用委派、消息或 handoff；
已经产生持久执行证据的工作若需调整，应创建新任务。
