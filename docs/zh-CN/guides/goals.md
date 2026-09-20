# 目标管理

[English](../../en/guides/goals.md)

`@may/goal` 提供独立的 `GoalController`、模型工具、Context 组合、使用量统计和保存接口。
基础 Agent package 保持独立。MaybeCode 为每个 Session 连接组件，在两个 Terminal 界面和
Web UI 中提供 `/goal`。

## MaybeCode 命令

```text
/goal start --max-runs 8 --tokens 100000 --duration-ms 1800000 -- 检查项目并完成要求的测试
/goal status
/goal pause
/goal resume
/goal cancel
```

`/goal` 也可以显示状态。预算参数位于目标内容之前，`--` 表示参数处理结束。
默认不限制 Run 数量、累计执行时间或 token 使用量；只有明确指定的预算参数才会生效。
未指定的预算在状态中显示为 `unlimited`。仅指定一项预算不会为其他项目添加限制。
预算数值必须是正的安全整数；`maxRuns` 最大为 10,000，执行时间最大为
2,147,483,647 毫秒。每个目标最多记录 10,000 次模型调用，同时遵守 Session 保存大小限制。

已有会话保存的预算保持原值，包括此前保存的默认预算；记录没有区分默认值与用户指定值。
若需要使用不限制 Run 数量和时间的新目标，可以取消现有目标，再执行 `/goal start <目标内容>`。
SDK 中的 `GoalState.budget.maxRuns` 和 `maxDurationMs` 为可选字段，读取时需要处理 `undefined`。

目标保存成功后，启动命令立即返回，执行在后台继续。未结束的目标需要完成或者取消后，才能创建新目标。
暂停保留目标内容和累计使用量。具有剩余预算的 `paused`、`blocked`、`failed` 目标可以恢复。
已经完成、取消或者预算耗尽的目标无法恢复。取消会永久停止该目标的后续执行。

Terminal 的 Ctrl+C 和 Web 取消操作会暂停目标并取消当前 Run。
新的用户消息会暂停目标，然后提交消息；恢复目标需要明确执行命令。
切换会话或模型要求应用空闲，请提前暂停目标。权限审批沿用现有策略。
组件只在目标运行期间提供 `get_goal` 和 `update_goal`，不会增加代码修改或 shell 权限。

模型使用 `update_goal({ status: "active", evidence })` 报告进度，使用 `completed` 申请完成，
使用 `blocked` 报告需要用户信息或者外部条件的情况。终止报告在完整的工具步骤结束后生效，
同一个步骤中已有的工具可以完成执行。完成记录注明依据来自模型报告。
SDK 宿主可以提供独立的 `verify` 验收函数；未通过验收的说明会作为下一次 Run 的进度信息。

## 组件连接

```ts
import { GoalController } from "@may/goal";
import { AgentApplication } from "@may/application";
import { InMemoryContextFactory } from "@may/context";

const goals = new GoalController();
const application = await AgentApplication.open({
  model: goals.wrapModel(model),
  store: sessionStore,
  permissionPolicy,
  tools: codingTools,
  toolSource: () => goals.tools(),
  contextFactory: goals.wrapContextFactory(new InMemoryContextFactory()),
});
await goals.attach(application, goalStore);
await goals.start("完成要求的工作", { maxRuns: 8 });
await goals.wait();
await goals.close();
await application.close();
```

`GoalAgent` 要求 `sessionId`、`isRunning`、`submit` 和 `continue`，运行 handle 提供
`id`、`result` 和 `cancel`。`GoalStore.read()` 返回最近保存的状态或者 `undefined`；
`write()` 必须等待持久化成功。宿主管理 Session，为每个活动 Session 创建独立 controller，
并串行处理影响同一个 Agent 的外部操作。
`AgentApplication.continue(options)` 是通用执行接口，沿用 `submit()` 的互斥、取消和保存流程。

使用 `goals.subscribe(listener)` 订阅 `goal.changed`。应用事件仍由原来的消费者处理，
目标调度等待运行结果。监听函数需要正常返回。后台执行错误通过目标状态和 `wait()` 报告；
保存失败会使 `wait()` 拒绝，并禁止继续使用该实例执行操作。

Goal Context 将动态 instructions 与当前宿主状态加入模型请求，提示内容纳入上下文估计，
发送位置的调整保留原有消息计数。状态提示会在上下文压缩后重新生成。
这条提示不写入原始用户消息。MaybeCode 通过应用拥有的 Session 状态，将目标记录保存在
`may.goal` 下。SDK 调用方可以在打开 MaybeCode 时使用 `goals: false` 禁用组件。
其他应用自行决定是否导入和连接这个 package。

## 预算与恢复

模型包装器在请求前记录 pending 调用，在交付完成事件前保存 provider 报告的使用量。
计数跨越 Run、模型切换和 Session 重新打开。内置摘要策略使用同一个包装后的模型。
每次 Run 自身的预算继续独立生效。

token 检查发生在响应返回时，最后一次响应可能超过剩余 token，之后停止执行。
缺少使用量、中断调用和失败的重试请求保留为未知状态。
有 token 预算的目标需要宿主核实后才能恢复：`goals.reconcileUsage(callId, verifiedTokens)`。
宿主必须根据 provider 证据取得数值。无法核实时仍然可以取消目标。
`/goal status` 会注明使用量不完整，程序接口 `getGoal()` 包含调用标识。

MaybeCode 会拒绝将 token 预算与原生自动压缩、自定义摘要或压缩策略共同使用，
因为这些路径无法保证完整计量。模型包装器也会拒绝在有 token 预算的目标中执行原生压缩。
原生压缩返回的上下文大小不能作为调用消耗。

进程异常退出后，活动目标恢复为暂停状态，pending 调用变为未知状态；
最近一次活动检查点之后的时间计入执行时间预算。正常暂停后的空闲时间不计入预算。
工具执行结果未知时继续遵守 Session recovery 检查。
重新打开会话不会自动重放工具或恢复目标。状态保存成功后才能继续执行，关闭应用会等待目标取消和状态保存。
