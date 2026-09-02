# Custom Context

**English** | [简体中文](../../zh-CN/guides/custom-context.md)

Core's `Context` is the model-visible working set for one runtime. It is not
the durable Session log. A Context decides which instructions, messages, and
metadata are presented to the next model request; Session records the facts
needed to rebuild that state later.

Most applications should start with `InMemoryContextFactory`. Supply a custom
`ContextFactory` to add observation, use another working-set implementation, or
expose different inspection and compaction behavior.

## Safest extension: decorate a factory

Decorating the built-in factory preserves its replay, budget, measurement, and
automatic-compaction behavior:

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

Wire the factory into the application rather than constructing a Context once
and sharing it across sessions:

```ts
const application = await AgentApplication.open({
  model,
  store,
  permissionPolicy,
  contextFactory: new AuditedContextFactory((entry) => console.log(entry)),
});
```

`AgentApplication` invokes the factory for a new or resumed Session and passes
the replayed messages into `create()`. A factory instance may be reused, but
each call must return an independent managed Context.

## Factory inputs

`ContextFactoryOptions` may include:

- `instructions`, replayed `messages`, and model-request `metadata`;
- a `budget` and the latest provider token `measurement`;
- a default manual `compactionStrategy`;
- an ordered `autoCompactionStrategies` chain.

A decorator should forward all options unchanged. A fully custom factory may
ignore unsupported management options, but must document that its returned
`ManagedContext` has no corresponding controller capability.

The optional `ContextController` is application-facing. It supports inspection,
provider usage measurements, explicit compaction, and pre-model automatic
compaction. If it is omitted:

- the agent can still run;
- `inspectContext()` returns `undefined`;
- `compactContext()` is unsupported;
- automatic compaction is unavailable.

## Implementing storage and replacement yourself

A new Context implementation must preserve these invariants:

1. `append()` commits messages in call order.
2. `snapshot()` returns a stable model view and does not expose mutable internal
   arrays.
3. instructions appear once, through `snapshot().instructions`; do not also
   insert a duplicate system message.
4. tool calls and their tool results stay paired and ordered.
5. cancellation passed in `SnapshotOptions.signal` is honored during expensive
   selection or compaction work.
6. metadata is treated as model/provider input, not as a secret store or an
   authorization boundary.

`SnapshotContextController` can add standard inspection and compaction around
a replaceable Context. Its `replaceMessages(messages, expectedMessages)` hook
should perform a compare-and-swap: return `false` if the active messages no
longer match `expectedMessages`. This prevents a compaction based on a stale
snapshot from overwriting messages appended concurrently.

If automatic compaction is required, the model-facing `snapshot()` must invoke
`controller.prepareForModel(options)` before returning the backing snapshot.
The built-in `InMemoryContextFactory` already wires this correctly, which is
why decoration is preferred over reimplementation.

## Persistence boundary

Context replacement is not automatically a durable history format. When using
`AgentApplication`, changed compaction results are recorded as Session
`context.compacted` events and are replayed on resume. When using Core and a
controller directly, the application must persist replacement messages itself.

Avoid two competing sources of truth. If a custom Context also loads messages
from a database, define how those records relate to the Session store; otherwise
the replayed `messages` passed to `create()` can be duplicated or silently
ignored. See [Custom storage](./custom-storage.md).

## Safety and observability

Context frequently contains user data, tool outputs, file contents, and model
reasoning. The audit example logs counts only. Redact before logging and do not
assume Session encryption: the built-in file store is plaintext.

Bound remote reads and compaction operations, propagate failures, and keep
network retry policy outside Core's minimal Context contract. A failed
`snapshot()` or `append()` fails the run; silently returning an older view can
cause the model and durable history to diverge.

See also [Custom model adapters](./custom-model.md) and
[Runtime and session boundaries](../architecture/runtime-session.md).
