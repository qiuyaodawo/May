# @may/application

`AgentApplication.continue(options)` continues the current context with the same
run lifecycle and persistence as `submit()`, without adding a user message.
It implements `ContinuableAgentController`; `retry()` retains its failed-run check.
External components can use this API without changing Agent internals. See
[Goals](../../docs/en/guides/goals.md).

`AgentApplication` implements `SteerableAgentController`. Use
`steer({ input, inputId?, runId? })` for durable FIFO input at the next complete
Step, and `listSteeringInputs()` for `pending`, `delivered`, `idle`, or
`cancelled` status. The host starts idle input with
`startSteeringInput(inputId, options?)`, which returns an ordinary `AgentRun` and
accepts Run options such as `shouldYield` and `signal`. Cancellation preserves
undelivered records; it never starts a subsequent Run automatically. Steering
while an operation starts or context compaction is active is rejected.
`cancelSteeringInputs(reason?)` durably cancels every pending or idle input and
preserves delivered input. A host-wide stop calls both `cancel(reason)` and
`cancelSteeringInputs(reason)` so idle follow-up work is also cancelled.
`submit()` and `continue()` use `SessionSubmitOptions` and
`SessionContinueOptions`. Custom `stepInputSource` callbacks are rejected before
execution; application input is accepted through `steer()` for durable history.
Direct `May.run()` and `May.continue()` continue to accept custom sources.

Pass `skills: SkillRegistry` to `defineAgent()` / `AgentApplication.open()` for
catalog guidance, `skill_read` and durable activation. `activateSkill(name)`
activates while idle; model activation uses the normal permission/tool path.
See [Agent Skills](../../docs/en/guides/skills.md).

Headless lifecycle components for composing a May Agent product.

`AgentWorkspace.readSessionHistory(id)` reads a catalog-owned session without
activating it, including while another session runs. Stores must provide the
optional non-repairing `inspect(id)` operation. The workspace does not fall back
to `read()` or create another application for browsing.

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

`recordState(key, value)` persists product-owned session state, including from a
tool during a Run. Pass `sessionHistory: { retrieval: true }` to also expose
bounded `session_history_search` and chunked `session_history_read` alongside
`session_history`. These tools only access this application's session.

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
