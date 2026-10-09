# 通过工厂扩展 Context

[English](../../en/guides/custom-context.md) | **简体中文**

`ContextFactory` 控制或观察发送给模型的消息，同时保留 Session 恢复能力。
本文为内置工厂增加消息数量记录，并说明替换实现需要遵守的要求。

多数应用应从 `InMemoryContextFactory` 开始。需要增加观察能力、采用另一种工作集实现，
或提供不同检查和压缩行为时，使用自定义 `ContextFactory`。

<a id="最安全的扩展装饰-factory"></a>

## 1. 包装内置工厂

包装内置工厂可以保留其回放、容量预算、用量测量和自动压缩行为。
在应用中创建 `audited-context.ts`，将 `@may/core` 和 `@may/context` 加入直接依赖：

```ts
import type {
  AppendOptions,
  Context,
  ContextSnapshot,
  Message,
  SnapshotOptions,
} from "@may/core";
import {
  InMemoryContextFactory,
  type ContextFactory,
  type ContextFactoryOptions,
  type ManagedContext,
} from "@may/context";

type Audit = (entry: {
  readonly operation: "snapshot" | "append";
  readonly messageCount: number;
}) => void;

class AuditedContext implements Context {
  constructor(
    private readonly delegate: Context,
    private readonly audit: Audit,
  ) {}

  async snapshot(options?: SnapshotOptions): Promise<ContextSnapshot> {
    const snapshot = await this.delegate.snapshot(options);
    this.audit({ operation: "snapshot", messageCount: snapshot.messages.length });
    return snapshot;
  }

  async append(
    messages: Message[],
    options?: AppendOptions,
  ): Promise<void> {
    await this.delegate.append(messages, options);
    this.audit({ operation: "append", messageCount: messages.length });
  }
}

export class AuditedContextFactory implements ContextFactory {
  constructor(
    private readonly audit: Audit,
    private readonly delegate: ContextFactory = new InMemoryContextFactory(),
  ) {}

  async create(options: ContextFactoryOptions): Promise<ManagedContext> {
    const managed = await this.delegate.create(options);
    return {
      context: new AuditedContext(managed.context, this.audit),
      ...(managed.controller === undefined
        ? {}
        : { controller: managed.controller }),
    };
  }
}
```

## 2. 使用工厂打开应用

在入口导入 `@may/application` 的 `AgentApplication`，以及 `./audited-context.js`
的 `AuditedContextFactory`。以下组合片段使用宿主已经初始化的 `model`、`store`
和 `permissionPolicy`：

```ts
const application = await AgentApplication.open({
  model,
  store,
  permissionPolicy,
  contextFactory: new AuditedContextFactory((entry) => console.log(entry)),
});
```

`AgentApplication` 会为新建或恢复的 Session 调用工厂，并把已回放消息传给
`create()`。工厂实例可以复用，每次调用必须返回独立的受管理 Context。

## 3. 验证 Context 相互独立

通过应用提交输入，观察仅包含数量的 `snapshot` 和 `append` 记录。
工作结束后关闭应用。重新打开已有 Session 时，确认工厂接收到回放消息；
打开新 Session 时，应得到独立消息视图。生命周期示例见[构建 Agent](building-an-agent.md)。

<a id="factory-输入"></a>

## 工厂输入

`ContextFactoryOptions` 可以包含：

- `instructions`、动态 `instructionsSource`、已回放 `messages` 和模型请求 `metadata`；
- `budget` 和最近 Provider token `measurement`；
- 默认手动 `compactionStrategy`；
- 有序 `autoCompactionStrategies` 链。

包装器应原样转发全部选项。完全自定义工厂可以忽略不支持的管理选项，
并说明返回的 `ManagedContext` 不具备相应控制器能力。

可选 `ContextController` 面向 Application，支持检查、Provider 用量测量、
显式压缩和模型调用前自动压缩。省略它时：

- Agent 仍能运行；
- `inspectContext()` 返回 `undefined`；
- `compactContext()` 不受支持；
- 自动压缩不可用。

## 自行实现存储与替换

新 Context 实现必须保持以下不变条件：

1. `append()` 按调用顺序保存消息。
2. `snapshot()` 返回稳定模型视图，不暴露可变内部数组。
3. 指令只通过 `snapshot().instructions` 出现一次，不重复插入 `system` 消息。
4. 工具调用与对应工具结果保持配对和顺序。
5. 耗时选择或压缩必须响应 `SnapshotOptions.signal` 取消。
6. 元数据会发送给模型或 Provider，应仅包含允许该服务读取的信息。

`SnapshotContextController` 可以围绕可替换 Context 添加标准检查与压缩。
`replaceMessages(messages, expectedMessages)` Hook 应实现比较并交换：若活动消息
已不匹配 `expectedMessages`，返回 `false`。这可防止基于旧快照的压缩覆盖并发
追加消息。

需要自动压缩时，面向模型的 `snapshot()` 必须先调用
`controller.prepareForModel(options)`。内置 `InMemoryContextFactory` 已正确连接，
包装时保留这一连接。

## 持久化边界

Context 替换需要单独保存。使用 `AgentApplication` 时，变化后的
压缩结果记录为 Session `context.compacted` 并在恢复时回放。直接使用 Core 和
控制器时，应用必须自行持久化替换消息。

提供 `rollbackCompaction(result)` 的控制器也应提供
`commitCompaction(result)`。保存成功后立即调用 `commitCompaction()`，再发送完成通知。
通知失败时继续传递错误，并保留已经保存的 Context。保存失败时调用 `rollbackCompaction()`。
内置控制器在提交时释放之前的消息与用量测量值；自动压缩也会在保存
方法成功返回后提交。
提交完成与当前操作对应的延后请求；之后到达的请求继续保留，包括使用相同
策略实例的新请求。

避免两个互相竞争的事实来源。如果自定义 Context 也从数据库加载消息，必须定义这些
记录与 Session 存储的关系，否则传给 `create()` 的回放 `messages` 可能重复或
被静默忽略。参阅[自定义存储](custom-storage.md)。

## 安全与可观察性

Context 经常包含用户数据、工具输出、文件内容和模型推理。上面的审计例子只
记录数量。记录日志前需要脱敏；内置文件存储是明文。

为远程读取和压缩设定边界、传播失败，并把网络重试策略留在 Core 最小 Context 接口
之外。`snapshot()` 或 `append()` 失败会使 Run 失败；静默返回旧视图可能让模型和
持久化历史产生不同内容。

另请参阅[实现模型适配器](custom-model.md)和
[Runtime 与 Session 边界](../architecture/runtime-session.md)。
