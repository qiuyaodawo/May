# 自定义 Context

[English](../../guides/custom-context.md) | **简体中文**

Core 的 `Context` 是一个 runtime 的模型可见工作集，不是持久化 Session log。Context
决定下一次模型请求看到哪些指令、消息和 metadata；Session 记录日后重建状态所需事实。

多数应用应从 `InMemoryContextFactory` 开始。需要增加观察能力、采用另一种工作集实现，
或暴露不同检查/压缩行为时，再提供自定义 `ContextFactory`。

## 最安全的扩展：装饰 Factory

装饰内置 factory 可以保留其 replay、budget、measurement 和自动压缩行为：

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

把 factory 接入 application，不要只构造一个 Context 再跨 Session 共享：

```ts
const application = await AgentApplication.open({
  model,
  store,
  permissionPolicy,
  contextFactory: new AuditedContextFactory((entry) => console.log(entry)),
});
```

`AgentApplication` 会为新建或恢复的 Session 调用 factory，并把已回放消息传给
`create()`。Factory 实例可以复用，但每次调用必须返回独立 managed Context。

## Factory 输入

`ContextFactoryOptions` 可以包含：

- `instructions`、已回放 `messages` 和模型请求 `metadata`；
- `budget` 和最近 provider token `measurement`；
- 默认手动 `compactionStrategy`；
- 有序 `autoCompactionStrategies` 链。

Decorator 应原样转发全部 option。完全自定义 factory 可以忽略不支持的管理 option，
但必须说明返回的 `ManagedContext` 不具备相应 controller capability。

可选 `ContextController` 面向 application，支持检查、provider usage measurement、
显式压缩和模型调用前自动压缩。省略它时：

- Agent 仍能运行；
- `inspectContext()` 返回 `undefined`；
- `compactContext()` 不受支持；
- 自动压缩不可用。

## 自行实现存储与替换

新 Context 实现必须保持以下不变条件：

1. `append()` 按调用顺序 commit 消息。
2. `snapshot()` 返回稳定模型视图，不暴露可变内部数组。
3. 指令只通过 `snapshot().instructions` 出现一次，不重复插入 system message。
4. Tool call 与对应 tool result 保持配对和顺序。
5. 耗时选择或压缩必须尊重 `SnapshotOptions.signal` 取消。
6. Metadata 是模型/provider 输入，不是 secret store 或授权边界。

`SnapshotContextController` 可以围绕可替换 Context 添加标准检查与压缩。
`replaceMessages(messages, expectedMessages)` hook 应实现 compare-and-swap：若活动消息
已不匹配 `expectedMessages`，返回 `false`。这可防止基于旧 snapshot 的压缩覆盖并发
追加消息。

需要自动压缩时，面向模型的 `snapshot()` 必须先调用
`controller.prepareForModel(options)`。内置 `InMemoryContextFactory` 已正确连接，
因此应优先装饰而非重写。

## 持久化边界

Context 替换不会自动成为持久化 history format。使用 `AgentApplication` 时，变化后的
压缩结果记录为 Session `context.compacted` 并在恢复时回放。直接使用 Core 和
controller 时，应用必须自行持久化替换消息。

避免两个互相竞争的事实来源。如果自定义 Context 也从数据库加载消息，必须定义这些
记录与 Session store 的关系，否则传给 `create()` 的 replayed `messages` 可能重复或
被静默忽略。参阅[自定义存储](custom-storage.md)。

## 安全与可观察性

Context 经常包含用户数据、工具输出、文件内容和模型 reasoning。上面的 audit 例子只
记录数量。日志前要脱敏，也不要假设 Session 已加密；内置 file store 是明文。

为远程读取和压缩设定边界、传播失败，并把网络重试策略留在 Core 最小 Context 契约
之外。`snapshot()` 或 `append()` 失败会使 Run 失败；静默返回旧视图可能让模型和
持久化 history 分叉。

另请参阅[自定义模型 Adapter](custom-model.md)和
[Runtime 与 Session 边界](../architecture/runtime-session.md)。
