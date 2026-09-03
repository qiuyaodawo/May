# 可观测性与 Tracing

[English](../../en/guides/observability.md) | **简体中文**

May tracing 用来解释一次 Agent Run 的耗时分布，以及 Core、Context、模型、工具、权限、
Session 和 application 之间的调用关系。它是可选的运行遥测，不是持久化对话历史。

## Event、历史与 Trace

- `MayEvent` 和 `AgentApplicationEvent` 用于实时呈现与生命周期观察；
- `SessionEvent` 是用于恢复和查询历史的 append-oriented 持久化事实；
- Trace 是可采样的运行数据，允许缓冲或丢弃，不能作为 Session 或权限状态的事实来源。

一个 `may.run` span 表示一次 Run。Model、Context、工具批次和工具调用 span 是它的
子节点；Permission span 是对应工具调用的子节点。Session 会给 Run 添加
`may.session.id`；同一 Session 中的不同 Run 仍是不同 Trace。

## 配置 Tracer

Core 只导出 `Tracer`、`TraceSpan`、`TraceContext`、attribute 和 fail-open helper 契约。
标准实现位于 `@may/observability`：

```ts
import { defineAgent } from "@may/application";
import {
  BasicTracer,
  BatchSpanProcessor,
  ConsoleSpanExporter,
  ratioSampler,
} from "@may/observability";

const processor = new BatchSpanProcessor(
  new ConsoleSpanExporter(),
  {
    maxQueueSize: 2_048,
    maxExportBatchSize: 256,
    scheduledDelayMs: 2_000,
  },
);

const tracer = new BasicTracer({
  processor,
  sampler: ratioSampler(0.1),
  resourceAttributes: { "service.name": "example-agent" },
});

const definition = defineAgent({
  model,
  tools,
  permissionPolicy,
  tracer,
  traceAttributes: { "may.agent.name": "example" },
});

const application = await definition.open({ store });
const run = await application.submit({ input: "Inspect the project" });
console.log(run.traceContext?.traceId);
await run.result;
await application.close();

// 仅在所有共享该 processor 的 application 都关闭后调用。
await processor.shutdown();
```

`AgentDefinition` 把 tracer 作为 caller-owned 协作者捕获，并浅快照 `traceAttributes`。
每次 Run 还可以增加不含内容的 attribute，或传入显式父 `traceContext`。
`ModelStreamOptions`、`ToolExecutionContext`、`RunHandle` 和 `AgentRun` 会暴露传播后的
trace context，供 provider、远程工具或上层操作继续建立子 span。

## 内置 Span

| Span | 作用 |
| --- | --- |
| `may.application.open` | 创建/恢复并校验一个 application Session |
| `may.run` | Core Run 根节点、结果、调用数和聚合 token usage |
| `may.context.snapshot` | 准备模型可见的 Context snapshot |
| `may.context.append` | 追加输入、assistant 或工具结果 message |
| `may.model.call` | 一次模型 stream、usage、工具调用数和 retry event |
| `may.tools.batch` | 调度一次模型响应产生的工具调用 |
| `may.tool.call` | 解析、授权并执行一个 Tool |
| `may.permission.check` | 执行 permission policy |
| `may.permission.approval_wait` | 等待显式审批决定 |
| `may.context.compact` | Application 显式请求的 Context 压缩 |

例如，一个慢工具调用可能显示为：

```text
may.tool.call                    9.72s
|- may.permission.check          0.01s
`- may.permission.approval_wait  8.90s
```

这样可以把用户审批等待与剩余的工具执行时间区分开。Model span 中的
`may.model.retry` event 同样可以把 provider retry 延迟与 Context 准备、工具耗时分开。

## Processor、Exporter 与采样

- `InMemorySpanProcessor` 保存完成的 span，用于测试和本地检查；
- `SimpleSpanProcessor` 在 Agent 调用栈之外串行调用 exporter；
- `BatchSpanProcessor` 使用有界队列并暴露 `droppedSpans`，不会把 exporter backpressure
  施加给 Run；
- 内置 `InMemorySpanExporter` 和 `ConsoleSpanExporter`；
- `alwaysOnSampler`、`alwaysOffSampler` 和 `ratioSampler()` 决定根 Trace 是否采样，
  子 span 继承父节点决定。

Processor 拥有异步导出和生命周期。需要等待已排队 span 时调用 `forceFlush()`；只在真正
owner 结束时调用一次 `shutdown()`。关闭一个 application 不得关闭仍被其他 application
共享的 processor。

外部 tracing 系统应通过自定义 `SpanExporter` 或 `SpanProcessor` 集成，provider SDK
类型不能进入 Core。

## 隐私与失败行为

内置 instrumentation 只记录名称、ID、数量、耗时、状态、token usage、权限决定以及
不含内容的错误类型/错误码。它不会捕获 prompt、message、reasoning、工具输入输出或
credential。自定义 `traceAttributes` 属于调用方数据，不应包含 secret、大型 payload
或无界的用户输入。

Core 会保护被注入的 tracer/span 调用；内置 processor 会捕获 exporter failure，并可
通过 `onError` 报告。因此遥测后端故障不会使 Agent 工作失败或取消。Tracing 也正因这种
fail-open 行为而不能代替持久化 audit 或 Permission 记录。

当前 package 提供 tracing 基础，而不是 metrics backend、dashboard 或厂商专用 exporter。
自定义 processor 可以从完成的 span 派生 metrics，无需改变 runtime 契约。
