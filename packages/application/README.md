# @may/application

Headless lifecycle components for composing a May Agent product.

`AgentDefinition` captures reusable Agent behavior and policy separately from
Session infrastructure. Create one with `defineAgent({ model, tools,
instructions, permissionPolicy, ... })`, then call
`definition.open({ store, sessionId?, resume?, metadata?, contextMetadata? })`
for each Session. Every call creates an independent `AgentApplication`.

```ts
import { defineAgent } from "@may/application";

const agent = defineAgent({
  model,
  tools,
  instructions,
  permissionPolicy,
});

const application = await agent.open({
  store,
  metadata: { workspace: process.cwd() },
});
```

The tools iterable is consumed and snapshotted when the definition is created,
so later registry or array membership changes do not alter it. Original Tool
identity is deliberately preserved for identity-keyed metadata; descriptor
fields are readonly, and descriptor/parser/executor references must remain
stable. Other collaborators are not cloned. In particular, a stateful
`Model`, `ContextFactory`, `ToolExecutor`, `ToolScheduler`, or policy captured
by a definition remains caller-owned and is shared by applications opened from
that definition; the caller must ensure any required concurrency and
isolation.

`AgentApplication` owns one durable session: it creates or resumes the runtime,
relays run and approval events, serializes active-run state, persists context
compaction, and closes outstanding work safely. Prompts, tools, permission policy
and optional tool-presentation metadata are injected by the product.

Call `AgentApplication.open()` directly when reusable definition/open
separation is unnecessary. It accepts any `Iterable<Tool>` and snapshots it
during opening. It also accepts an optional `toolScheduler` and forwards it to
the Core runtime; definitions capture the same option as reusable policy.

Definitions and direct applications also accept an optional Core `tracer` and
content-free `traceAttributes`. The tracer is forwarded to Core and the
permission executor; Run handles expose their `traceContext`, and Sessions add
their id as an attribute. A tracer is a caller-owned shared collaborator:
closing an application does not flush or shut it down. Standard processors and
exporters live in `@may/observability`.

`AgentWorkspace` adds a session catalog, auto-resume, session switching and a
serialized application-transition primitive. Products retain their own model
profiles and can use `transitionApplication` to rebuild the same session after a
model/configuration change. Product-only mutations that do not rebuild the
runtime can use `runStateTransition` so they share the same FIFO queue as
session operations.

This package owns orchestration, not product policy. Callers still choose the
prompt, tools, permissions, Context strategies, model/provider configuration,
and UI. Its current `0.1.0` surface is a developer-preview API.

```ts
import { AgentWorkspace } from "@may/application";

const workspace = await AgentWorkspace.open({
  workspace: process.cwd(),
  store,
  catalog,
  autoResume: true,
  openApplication: ({ sessionId, resume }) => agent.open({
    store,
    metadata: { workspace: process.cwd() },
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(resume ? { resume: true } : {}),
  }),
});
```
