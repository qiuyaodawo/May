# 委派子 Agent 执行任务

[English](../../en/guides/subagent-delegation.md) | **简体中文**

普通 MaybeCode 请求可以将独立工作交给子 Agent。终端界面、Web UI、无头
控制器和 `MaybeCodeApplication.open()` 默认启用委派。模型在活动 Run 中
可以调用 `delegate_tasks`，按照用户提示委派，也可以自行选择委派。

本指南要求已有[MaybeCode Session 配置](maybecode.md)，介绍请求行为、角色、
文件分工、预算和恢复。可复用实现位于 `@may/plugin-delegation`，MaybeCode
将该插件与 `@may/coordination` 提供的 `delegate_tasks` 工具组合。

## 请求委派工作

1. 在需要检查的工作区中打开 MaybeCode。
2. 提交包含独立任务、文件分工和证据要求的提示。例如：“分别委派子 Agent
   检查源代码和测试。每项发现引用文件并说明验证缺口，最终回答汇总两份结果。”
3. 执行期间检查任务树、子任务审批和用量，通过 `/delegations` 查看持久状态。
4. 阅读最终回答及子任务结果。失败子任务的状态会进入唤醒数据，由主 Agent 处理。

## 一次请求、多个 Run、一个最终回答

一次用户请求就是一张持久协调图。主 Session 执行根任务。模型调用
`delegate_tasks` 时，工具记录子任务，当前 Run 在下一个完整 Step 结束处让出名额
（`finishReason: "yielded"`），根任务释放并发名额。每个子任务在自己的 Session 中
运行，拥有自己的 Context、Skills 与压缩状态。全部子任务进入终态之后，主 Session
继续执行新的 Run，把子任务报告作为数据收到上下文里，再生成给用户的回答。

`controller.submit(...)` 返回的 `MaybeCodeRun` 表示整次请求。
以下片段要求已经打开 `MaybeCodeController`、准备 Session 输入，并由宿主
消费审批事件：

```ts
const run = await controller.submit({ input });
const result = await run.result;               // 最终汇总结果
const runs = await run.runs();                 // 本请求内每个真实 Run 的身份与结果
console.log(run.requestId, runs.map((item) => `${item.turn}:${item.runId}`));
```

Goal 的 Run 与 steering 的 Run 同样是一次请求，因此宿主启动的每个 Run 都可以委派，
主 Session 不会同时存在两个写入方。

## 配置

在宿主使用的 May 配置中合并 `apps.maybecode.subagents`。下文的
`reviewer.model` 是已配置模型名称，需要替换为配置中存在的名称，并确认模型
支持所选 reasoning effort。以下限制用于展示配置格式，实际默认值见片段之后。

```jsonc
{
  "apps": {
    "maybecode": {
      "subagents": {
        "roles": {
          "worker": {
            "instructions": "只检查并修改被分配的文件。",
            "tools": ["read", "shell", "edit", "write"],
            "delegateTo": ["worker"]
          },
          "reviewer": {
            "model": "deepseek-v4-flash",
            "reasoningEffort": "high",
            "tools": ["read"],
            "delegateTo": []
          }
        },
        "defaultRole": "worker",
        "limits": {
          "maxConcurrent": 2,
          "maxTasks": 24,
          "maxDepth": 3,
          "maxTaskTurns": 6,
          "maxDurationMs": 900000
        },
        "runBudget": { "maxSteps": 24, "maxModelCalls": 24, "maxToolCalls": 48 },
        "maxModelCalls": 128,
        "maxTotalTokens": 200000,
        "reservationTokens": 32768
      }
    }
  }
}
```

`"subagents": false` 或 `{"enabled": false}` 关闭委派：工具不会出现，也不会创建请求。
`worker` 角色默认注册，因此不配置也能委派。没有声明 `model` 的角色继承主会话的模型
与 reasoning effort；声明 `model` 的角色使用自己的模型与 `reasoningEffort`。
角色只能创建自己 `delegateTo` 中列出的角色。

主请求是第 1 层，委派得到的子任务是第 2 层，孙任务是第 3 层；`maxDepth` 拒绝更深的
委派，`maxTasks` 限制一次请求的任务总数，包含主任务。

任务图默认最多并发 2 个任务、总计 24 个任务、深度 3、每个任务 6 轮、每次请求
15 分钟。任务输入限制为 32,768 个 UTF-8 字节，输出限制为 65,536 字节。
子 Run 默认截止时间为 5 分钟。默认省略 `maxTotalTokens`，需要限制请求 token
额度时显式设置该字段。

## 提示词、任务说明与文件分工

每个子任务说明必须自成一体：目标、约束、期望的证据与报告格式。子任务只收到这份
说明，父任务的对话历史保持独立，报告作为数据传递。子任务的 `files` 声明
它可以修改的工作区相对文件：

- 子任务可以读取工作区内的任何文件；
- `write` 与 `edit` 拒绝 `files` 之外的路径；
- 已存在的文件必须由该子任务先读取，读取之后内容发生变化的文件会被当作冲突拒绝；
- `shell` 工具没有这些限制，因此任务说明要明确写出文件分工。

文件锁与版本检查由主任务和同一工作区的全部子任务共享，覆盖本应用提供的文件工具。
本应用之外的进程所做的修改会在下一次操作时被发现，但不会被阻止。

## 额度

子 Run 缺省获得 24 步、24 次模型调用和 48 次工具调用；子 Run 取角色 `runBudget` 与
`apps.maybecode.subagents.runBudget` 中较小的值。主 Run 缺省 32 步，调用方只能通过
`maxSteps` 选项改变该上限，可以调大也可以调小。一次请求的主 Run、全部子 Run、Run 内的
摘要调用与 provider 原生压缩调用共享同一本持久账本，默认额度为 128 次模型调用。
每一次真实的 provider 尝试都在发出之前预留额度，因此并发调用、额外的 Step 与 provider 自动
重试都受同一个上限约束。每一次 attempt 各自有一条账本记录：重试包装在下一 attempt 之前发出
`retrying` 事件，账本先把失败的那次尝试记为 unknown，再在下一 attempt 发出之前预留它。
被账本拒绝的 attempt 不会被发出，请求以触发这次重试的 provider 错误结束，错误里同时包含
provider 错误的 name、message、code、该 attempt 的调用身份与账本阻塞的原因。
没有活动请求账本时，`apps.maybecode.retry` 的重试行为保持不变。

token 上限按单次调用的预留值检查：额度不足时在发出之前失败。已经发出的并发调用按真实
usage 结账，因此多个并发调用的超出量会累加；账本阻塞之后，请求在下一次模型调用之前
停止。provider 不上报 usage 时该次调用记为 unknown，效果相同，因此不会跳过用量统计；
该次请求的自动重试也会在发出之前被拒绝，因为失败的那次尝试已经是 unknown。进程异常退出后，
pending 调用在重新打开账本时变成 unknown。Goal 与 steering 的 Run 同样是一次请求，
其调用计入同一本账本。

上报 usage 的原生压缩按真实用量结账。没有 usage 的压缩器按预留值计账并标记为估计值，
此时请求报告中的 token 总计会显示为不完整。token 总计由 provider 用量与估计值组成，
provider 的实际账单仍取决于已经接受的请求。

## 审批、取消与恢复

子任务的工具请求使用与主 Session 相同的权限策略：明确拒绝仍然是拒绝，会话授权
不会共享。审批会路由到提出请求的任务，TUI、Web UI 与无头调用方仍然通过
`resolveApproval` 回答。新的用户输入、`cancel` 和 `close` 会停止请求、子任务及其后代。
切换会话或模型需要等待当前请求结束，或者取消当前请求。

明确取消的请求返回 `RunCancelledError`。被中断的模型调用在账本中保留 unknown
用量，请求报告的 `usageComplete` 保持 false。

进程在请求进行中结束时，持久记录会保留下来。再次启动时该请求被报告为中断，未结束的
任务标记为 recovery-required，并且不会重放任何工具、模型调用或子任务 Run。核对外部
影响之后，可以在协作运行时保持停止的情况下，为排队任务和等待子任务的父任务
记录结束结论：

```text
/delegations
/delegations tools <task-id>
/delegations resolve <task-id> <failed|cancelled> <verified-finding>
```

遗留的写入锁不会被自动接管；确认所有者进程已经结束之后，使用协调锁的恢复命令并
提供完全一致的锁内容。
最近请求索引保留最多 16 次请求。请求结束之后，持久化任务记录和预算记录继续保存在磁盘中。

## 界面

- TUI 与 retained TUI 打印请求开始与结束、带父任务标识的任务树、任务状态，以及以
  任务 id 为前缀的子任务工具输出与子任务审批。
- Web UI 增加“子 Agent”面板，显示任务树、本次请求的用量以及上面的命令；控制台同样
  可以执行 `/delegations`。
- 无头调用方接收 `delegation.started`、`delegation.updated`、`delegation.finished`
  与 `delegation.event` 事件，以及 `listDelegationRequests()`、`getDelegationState()`、
  `delegationToolRecords()` 和 `resolveDelegationRecovery()`。
- `/instructions` 在本次 Run 的委派工具可用时显示与模型收到的协作部分相同的内容，
  包括当前授权的角色和执行限制。
