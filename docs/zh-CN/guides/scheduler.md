# 持久化时间与事件调度

[English](../../en/guides/scheduler.md) | **简体中文**

`@may/scheduler` 保存触发规则和独立的执行快照，通过宿主提供的 `TaskDispatcher`
提交任务。导入 package 和调用 `Scheduler.open()` 不会创建计时器或启动 Agent。
宿主管理 Agent 配置、Session 选择、任务执行、审批和结果投递。公共 API 当前属于
开发预览版。

## 每日简报

```ts
import { Scheduler } from "@may/scheduler";
import { SqliteSchedulerStore } from "@may/scheduler/sqlite-store";

const scheduler = Scheduler.open({
  store: SqliteSchedulerStore.open("./data/scheduler.sqlite"),
  dispatcher: taskService,
  maxConcurrentSubmissions: 4,
  onError: error => console.error(error),
});

await scheduler.createJob({
  id: "daily-ai-brief", enabled: true,
  trigger: { type: "cron", expression: "0 8 * * *", timezone: "Asia/Shanghai" },
  task: {
    handler: "ai-brief",
    payload: { agent: "researcher", prompt: "总结 AI 发展并提供来源链接。" },
  },
  misfire: { policy: "latest", graceMs: 7_200_000 },
});
await scheduler.start();
// 宿主正常关闭时调用 scheduler.close()。
```

`taskService.submit(request)` 必须在任务持久化接受后返回 `{ taskId }`。相同
`executionId` 的重复调用必须返回相同任务身份，保持 Agent 任务执行去重。
宿主可以把任务加入执行队列，使用自己的 Worker 启动 Agent，并单独投递结果。
简报的统计范围根据 `request.scheduledAt` 计算，延迟启动仍保持原定范围。

组件调用提交接口前保存 `dispatching`，宿主确认接受后保存 `submitted` 和
`taskId`。进程在这两项操作之间中断时，下一次 `tick()` 或 `start()` 使用相同
身份重新提交。宿主提交凭据证明任务已经接受；Agent 完成和结果投递各自具有
宿主记录。

使用系统 cron、systemd timer 或 Windows Task Scheduler 时，打开存储，调用
`tick()`，随后关闭组件。常驻服务可以调用 `start()` 并保持进程运行。同一个
Scheduler 的两种运行方式分别使用。May 不会注册系统服务或自动启动应用。

## 规则与修改

`at` 使用包含 `Z` 或数字 UTC offset 的 ISO 时间。`cron` 要求五个字段和 IANA
timezone。`cron-parser` 负责表达式解析，随机 `H` 字段和预定义别名会被拒绝。
夏令时产生的不存在时间跳过；重复的本地分钟仅在第一次出现时触发。`event`
匹配准确的 topic。宿主完成 webhook 和发布者验证后调用 `publish()`。

Job ID、handler、事件 source、事件 ID 和 topic 使用 1 到 256 个字符，不得包含
控制字符。topic 还需要包含非空白内容。事件时间包含日期、时间和明确的 UTC offset。

创建和修改操作立即验证输入。任务具有单调递增的 `revision`。
`updateJob(id, changes, expectedRevision)` 和
`deleteJob(id, expectedRevision)` 拒绝过期的修订版本。每个执行记录保留接受时的
完整任务快照。暂停或删除规则不会取消已经接受的任务。重新启用任务从启用时间
计算计划时间。删除后的 ID 保留占用，保护历史身份和去重记录。

`task.payload` 和事件 payload 必须是有限的 JSON 内容。时间使用字符串，序号和
修订版本使用安全整数。任务和事件 payload 最多 64 KiB，嵌套最多 60 层。
单个存储 JSON 内容最多 1 MiB，嵌套最多 64 层。凭据由宿主服务管理，payload
保存配置引用。

## 延迟启动

`graceMs` 表示到期任务允许的延迟。在允许范围内处理时，两种策略均允许提交。
最早尚未处理的时间已经超过允许范围时：

- `skip` 记录错过的时间范围，跳过执行；
- `latest` 仅选择最近一次到期时间，在允许范围内提交，并将更早的任务记录为跳过。

示例任务在九点恢复时提交八点的任务；十一点恢复时跳过该次任务。长时间停止
导致的历史 cron 时间使用数量有限的跳过记录保存，`detail` 描述错过的时间范围。
单次任务允许指定过去时间，并使用相同规则。

## 事件

```ts
const records = await scheduler.publish({
  source: "github", id: "delivery-123", topic: "issue.opened",
  occurredAt: "2026-10-04T10:00:00+08:00",
  payload: { repository: "example/project", issue: 123 },
});
```

事件和全部匹配任务的执行快照在同一个事务中接受。重复的 `source` 和 `id`
返回原来的匹配结果；相同身份携带不同内容时报错。JSON 对象属性顺序不影响
内容身份。接受事件后新增或修改的任务不会接收历史事件。`publish()` 提交
已经接受的执行记录并返回当前状态。显式发布事件只需要打开组件。

## 生命周期与错误

`start()` 要求提供 `onError`，启动内部唤醒循环。后台错误停止循环并报告错误。
`tick()` 的错误通过 Promise 拒绝返回。后台 `onError` 自身产生的异常作为未捕获
错误继续抛出。宿主能够确认没有接受任务时，使用
`TaskRejectedError`，组件保存 `failed`。其他提交错误保留 `dispatching`；重新
调用 tick 时保持原来的执行身份。存储错误停止后续操作，要求重新打开 Scheduler。

`stop()` 立即停止接受新的事件，等待已经接受的操作和提交完成。随后显式调用
`tick()` 或 `start()` 可以恢复接受。`close()` 完成停止、等待和存储释放，重复
关闭安全。提交接口必须完成自己的 Promise；组件不会根据等待超时推断任务
是否接受，也不会取消宿主的 Agent 执行。

`maxConcurrentSubmissions` 限制同时进行的提交调用。宿主管理 Agent 执行并发、
Run 预算和 Session 顺序执行。`listExecutions({ jobId?, status?, afterSeq?, limit? })`
使用稳定递增序号分页，默认每页 100 条，最多 1,000 条。

## 存储与部署

`SchedulerStore` 提供同步 `get`、`list`、`put`、`delete`、`transaction` 和 `close`。
事务中的操作必须一起提交或一起终止，事务不能返回 Promise。Scheduler 打开期间
独占使用存储。

SQLite adapter 使用 `node:sqlite`、数据库身份和版本验证、WAL 及 FULL 同步。
独立的 SQLite 数据库通过独占事务管理宿主使用权。进程终止后，SQLite 释放锁，
宿主可以重新启动并恢复；相关数据库文件继续保留。其他活动宿主立即收到错误。
存储应使用正确支持 SQLite 文件锁的本地文件系统。宿主运行期间不要删除相关
文件。存储包含明文任务和事件内容，应使用宿主访问控制并保存备份。
执行记录、事件去重记录和已经删除的 ID 持续保存，宿主管理归档与存储容量。

Core、Session 和 Application 不依赖本组件。这次新增组件的发布 package 列表为
`@may/scheduler`，初始版本 `0.1.0`，功能 Changeset 使用 minor。运行时依赖是
`cron-parser` 和 `luxon`。版本准备和发布分别需要用户指令。

## 验证

```powershell
pnpm --filter @may/scheduler test
pnpm --filter @may/scheduler test:live
pnpm test:package:scheduler
pnpm test:integration:scheduler
pnpm docs:check
```

测试使用真实 SQLite、真实宿主任务凭据、执行产物处理器和子进程中断。
`test:live` 记录准确开始时间，并把单次任务设置在该时间加 60,000 ms 后执行。
输出包括计划时间、观察到的提交时间、延迟、执行身份、宿主任务身份和生成的产物。
结果位于已经忽略的 `scheduler-verification/` 目录。这个离线宿主验证覆盖调度
和任务接受，模型调用与新闻获取需要相应的集成验证。

`test:integration:scheduler` 使用宿主配置的默认模型，进行一次真实 May Agent
调用。任务设置在记录的开始时间加 60,000 ms 后执行，获取 `vllm-project/vllm`
和 `huggingface/transformers` 前面 24 小时的公开 GitHub Release 数据，并生成
`brief.md`、`notification.json` 和 `report.json`。没有符合时间范围的来源时，
简报明确说明结果。这个限定来源的测试验证调度到 Agent 执行的路径；生产新闻
处理器提供自己的来源范围和投递方式。通知产物保存在本地。命令需要网络访问和
有效的模型配置，并使用配置中的 provider 额度。
