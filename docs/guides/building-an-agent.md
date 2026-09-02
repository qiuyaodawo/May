# Building an Agent

**English** | [简体中文](../zh-CN/guides/building-an-agent.md)

May is a set of composable packages, not a single preconfigured assistant.
An application chooses behavior and policy, while the framework supplies the
execution and lifecycle mechanisms. This guide explains those choices using
the APIs currently implemented in the repository.

Start with [Getting started](../getting-started.md) if you have not run an
Agent yet. The terms Agent definition, Session, Run, and Step are defined in
[Runtime and session boundaries](../architecture/runtime-session.md).

> **Current API:** “Agent definition” is a design concept in May `0.1.0`, not a
> `defineAgent()` function. Tools are passed as an array; there is no global
> `ToolRegistry`. Keep product composition in an ordinary factory function as
> shown below instead of depending on APIs that do not exist yet.

## The composition model

```text
Product-owned decisions
  model + instructions + tools + permission policy + Context policy
                              |
                              v
                    AgentApplication
                              |
               Session + permission executor
                              |
                              v
                     May (Core runtime)
                              |
                Model <-> tools, by Steps

Optional product shell
  AgentWorkspace -> active AgentApplication -> Session Catalog
  UI             -> controller methods + application/workspace events
```

The important dependency rule is one-way: an executable product under `apps/`
selects packages, while reusable packages do not import that product.
MaybeCode is a reference composition, not a required superclass or runtime.

## Choose the lifecycle level first

| Start with | Use it when | You must own |
| --- | --- | --- |
| `May` from `@may/core` | One-shot, ephemeral, or deeply embedded execution | Context continuity, persistence, permissions, and shutdown above the run |
| `Session` from `@may/session` | You need a durable conversation identity but want to assemble lifecycle pieces manually | Runtime reconstruction, permission event persistence, discovery, and UI relays |
| `AgentApplication` from `@may/application` | A headless product needs one active resumable Session | Product model, tools, instructions, policies, storage, and event handling |
| `AgentWorkspace` from `@may/application` | A product lets users create, list, resume, rename, or delete Sessions | An application factory, a `SessionCatalog`, and product-specific configuration transitions |

Most interactive products should begin with `AgentApplication`. Use Core
directly only when its deliberately small boundary is the feature you need.
Do not layer a second `Session` around `AgentApplication`: the application
already owns one.

## Required and optional inputs

`AgentApplication.open()` requires:

- a `Model`;
- a `SessionStore`;
- a `PermissionPolicy`.

Everything else is a deliberate optional choice:

- `tools` defaults to no product tools;
- `instructions` defaults to no system instructions;
- `contextFactory` defaults to `InMemoryContextFactory`;
- Context budgets and compaction are disabled unless configured;
- a Session is new unless both `sessionId` and `resume: true` are supplied;
- the bounded `session_history` tool is installed only when
  `sessionHistory` is an options object;
- tool-presentation metadata is produced only when the product supplies
  `createToolPresentation`.

## Keep composition in one factory

The following TypeScript factory is a complete, provider-neutral application
composition. Its caller supplies any object implementing Core's `Model`
contract.

Required workspace dependencies for this file are:

```json
{
  "dependencies": {
    "@may/application": "workspace:*",
    "@may/context": "workspace:*",
    "@may/core": "workspace:*",
    "@may/session": "workspace:*"
  }
}
```

```ts
import { AgentApplication, type AgentApplicationOptions } from "@may/application";
import { InMemoryContextFactory, PruneOldToolResultsStrategy } from "@may/context";
import type { Model, Tool } from "@may/core";
import type { SessionStore } from "@may/session";

export interface OpenExampleAgentOptions {
  readonly model: Model;
  readonly store: SessionStore;
  readonly workspace: string;
  readonly sessionId?: string;
  readonly resume?: boolean;
}

const lookup: Tool<{ key: string }, { value: string | null }> = {
  name: "lookup",
  description: "Look up a value in the product's read-only data source",
  inputSchema: {
    type: "object",
    properties: { key: { type: "string" } },
    required: ["key"],
    additionalProperties: false,
  },
  parse(input) {
    if (
      typeof input !== "object" || input === null ||
      !("key" in input) || typeof input.key !== "string"
    ) {
      throw new TypeError("key must be a string");
    }
    return { key: input.key };
  },
  async execute({ key }, context) {
    context.signal.throwIfAborted();
    return { value: key === "status" ? "ready" : null };
  },
};

export function openExampleAgent(
  options: OpenExampleAgentOptions,
): Promise<AgentApplication> {
  const prune = new PruneOldToolResultsStrategy({
    keepRecentToolResults: 4,
    minimumResultBytes: 2_048,
  });

  const applicationOptions: AgentApplicationOptions = {
    model: options.model,
    store: options.store,
    tools: [lookup],
    instructions: [
      "You are Example Agent.",
      "Use lookup when a requested value may exist in the data source.",
      "Do not invent missing values.",
    ].join("\n"),
    metadata: { workspace: options.workspace, agent: "example" },
    contextMetadata: { workspace: options.workspace },
    permissionPolicy: ({ tool }) =>
      tool.name === "lookup" ? "allow" : "deny",
    contextFactory: new InMemoryContextFactory(),
    contextBudget: {
      contextWindowTokens: 64_000,
      outputReserveTokens: 4_096,
      toolReserveTokens: 2_048,
      safetyMarginTokens: 1_024,
      compactTriggerRatio: 0.9,
    },
    compactionStrategy: prune,
    autoCompactionStrategies: [prune],
    sessionHistory: {
      maxEvents: 50,
      maxOutputBytes: 32 * 1_024,
      maxEventBytes: 8 * 1_024,
    },
    maxSteps: 16,
    ...(options.sessionId === undefined
      ? {}
      : { sessionId: options.sessionId }),
    ...(options.resume === true ? { resume: true } : {}),
  };

  return AgentApplication.open(applicationOptions);
}
```

The factory is the product's effective Agent definition. It is easy to test,
and it makes every behavior-changing choice reviewable in one place. The
64,000-token budget above is an example value, **not** a statement about every
model. Use limits documented by the selected provider/model; reserve enough
space for output and expected tool payloads.

## Make each composition decision explicitly

### Model and provider

Core depends on the provider-neutral `Model` interface. Select one concrete
adapter at the product boundary, add its package as a direct dependency, and
keep secrets outside Session metadata and instructions.

For example, a DeepSeek entry point can construct the model before calling the
factory:

```ts
import { DeepSeekModel } from "@may/provider-deepseek";

const apiKey = process.env.DEEPSEEK_API_KEY;
const modelName = process.env.DEEPSEEK_MODEL;
if (!apiKey || !modelName) {
  throw new Error("Set DEEPSEEK_API_KEY and DEEPSEEK_MODEL");
}

const model = new DeepSeekModel({ apiKey, model: modelName });
```

This snippet additionally requires
`"@may/provider-deepseek": "workspace:*"`. Other built-in provider packages
are listed in the [configuration reference](../reference/configuration.md). Provider
adapters normalize output into Core events but retain responsibility for
provider request formats, supported content, retries, and native continuation
state.

### Instructions

Instructions are product policy. They should describe the Agent's role,
boundaries, available workflow, and required output behavior without embedding
secrets.

For a coding product, `@may/coding-tools/instructions` can safely compose a
default system prompt with bounded runtime and workspace instruction files.
Generic products can load or generate their own string. On Session resume,
the application uses the instructions supplied by the **current** product
configuration; Session history is not a frozen copy of the entire Agent
definition.

### Tools

A Tool owns one capability, its JSON Schema, optional input parser, execution,
and cancellation behavior. Prefer a strict `parse()` implementation even when
the schema is also supplied: the parser gives the executor a validated,
typed value and rejects malformed provider output at runtime.

Tool names must be unique within a runtime. `May` rejects duplicate names, and
`AgentApplication` reserves `session_history` when that optional tool is
enabled. The current API composes tools as an array; keep grouping functions
local to a tool package or product rather than assuming a global registry.

Tool execution receives an `AbortSignal` and can report live progress through
`context.report(...)`. Respect cancellation in I/O and subprocesses. Ordinary
tool failures become model-visible error results so the model may recover;
reserve fatal errors for infrastructure that cannot safely continue.

Cross-cutting execution behavior belongs at Core's `ToolExecutor` seam.
`AgentApplication` accepts a `toolExecutor` and wraps it with its permission
executor, so logging, sandbox dispatch, or timeouts can be injected without
changing every Tool.

### Permissions are not a sandbox

The `PermissionPolicy` runs after tool input is parsed and before execution:

```ts
const permissionPolicy = ({ tool, input }) => {
  if (tool.name === "read") return "allow";
  if (tool.name === "write") {
    return {
      decision: "ask",
      grantKey: `write:${JSON.stringify(input)}`,
    };
  }
  return "deny";
};
```

`"allow-session"` is available only for a scoped ask with a `grantKey`; grants
live in the application's permission executor and disappear when it closes.
The policy is still evaluated on later calls, so a later `"deny"` wins.

When the policy asks, an event handler must surface the request and call:

```ts
await application.resolveApproval(requestId, "allow");
// Other decisions: "allow-session" or "deny".
```

Approval determines whether an operation may run. It does not constrain what
an allowed process, network request, or filesystem operation can affect. For
untrusted execution, supply a restricted execution backend at the tool or
`ToolExecutor` boundary in addition to permissions. In particular,
`@may/coding-tools` documents that its shell tool is not a sandbox.

### Context and compaction

Context is the current model-visible view, not the durable audit log.
`InMemoryContextFactory` is the default and can expose inspection plus manual
and automatic compaction through its controller.

Choose these separately:

1. **Budget:** model window minus output, tool, and safety reserves.
2. **Manual strategy:** `compactionStrategy` used by an explicit
   `application.compactContext()` call.
3. **Automatic chain:** ordered `autoCompactionStrategies` tried when the
   configured trigger is reached.
4. **Native compaction:** `providerNativeAutoCompaction: true` includes a
   model adapter's native compactor only when no explicit automatic chain is
   supplied. If exact ordering matters, wrap it with
   `ModelContextCompactionStrategy` and include it in your explicit chain.

The framework persists a changed compacted view as a Session event before
continuing. Older durable facts remain in history. If the Agent needs details
that compaction removed from the model view, enable the bounded
`session_history` tool or provide another retrieval mechanism.

### Session storage

Select storage by deployment boundary:

- `InMemorySessionStore`: deterministic tests, demos, or process-local work;
- `FileSessionStore` from `@may/session/file-store`: local plaintext JSONL
  across restarts;
- a product implementation of `SessionStore`: databases, encryption, remote
  storage, or stronger concurrency requirements.

The built-in file store assumes one active writer per Session. Do not promise
multi-process or distributed coordination on top of it without adding that
control in your product or backend.

Session metadata should contain stable, non-secret facts needed to validate a
resume. Use `validateSession` to reject a history that belongs to an
incompatible workspace or product. Models, API keys, executable Tool objects,
and permission grants are runtime configuration and are not restored from the
Session log.

### Tool presentation metadata

Some UIs need information, such as a diff, before asking for approval. Supply
`createToolPresentation(check)` to return namespaced, versioned, JSON-safe
metadata. `AgentApplication` records it before permission evaluation and emits
`tool.presentation` live. Session deliberately excludes it from the
model-visible conversation.

The product owns the `kind`, `version`, and data schema. Decode persisted data
defensively. Coding products can reuse change-preview helpers from
`@may/coding-tools/change-preview` rather than inventing another format.

## Consume one ordered application stream

A long-lived UI normally starts one relay immediately after opening the
application:

```ts
const relay = (async () => {
  for await (const event of application.events) {
    switch (event.type) {
      case "run.event":
        renderRunEvent(event.event);
        break;
      case "permission.event":
        await handlePermissionEvent(event.event);
        break;
      case "tool.presentation":
        renderToolPresentation(event.presentation);
        break;
      case "context.compacted":
      case "context.compaction.failed":
        renderContextNotice(event);
        break;
    }
  }
})();

try {
  const run = await application.submit({ input: "Inspect the current state" });
  const result = await run.result;
  renderFinalMessage(result.message);
} finally {
  await application.close();
  await relay;
}
```

`renderRunEvent`, `handlePermissionEvent`, and the other functions above are
intentionally product/UI functions; May does not prescribe them. A terminal
product can use the Agent transcript from `@may/tui`, while a graphical or
remote client can consume the same headless stream directly.

Treat the stream as live observation:

- correlate run events by `runId` and order them by `seq`;
- tolerate gaps in high-volume text, reasoning, output, or progress deltas
  when a bounded queue is under pressure;
- use `run.result` and `application.history()` for authoritative finalized
  data;
- keep consuming while an approval may be requested;
- handle a rejected result even when a terminal failure event was rendered.

Only one Agent operation may be active per `AgentApplication`. `cancel()`
cancels the active run or compaction. `retry()` is valid only when the latest
run failed and continues without appending a duplicate user message.

## Single Session or Workspace

Use `AgentApplication` alone if a product has one known Session at a time and
stores its id elsewhere. Add `AgentWorkspace` when the product needs discovery
and switching.

The following local composition requires the same application dependencies as
the factory above and uses the `@may/session/catalog` and
`@may/session/file-store` export paths:

```ts
import { AgentWorkspace } from "@may/application";
import { FileSessionCatalog } from "@may/session/catalog";
import { FileSessionStore } from "@may/session/file-store";
import { join } from "node:path";

const stateDirectory = join(process.cwd(), ".may");
const store = new FileSessionStore(join(stateDirectory, "sessions"));
const catalog = new FileSessionCatalog(join(stateDirectory, "catalog.json"));

const workspace = await AgentWorkspace.open({
  workspace: process.cwd(),
  store,
  catalog,
  autoResume: true,
  openApplication: ({ sessionId, resume }) =>
    openExampleAgent({
      model,
      store,
      workspace: process.cwd(),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(resume ? { resume: true } : {}),
    }),
});

try {
  const run = await workspace.submit({ input: "Read the status value" });
  await run.result;

  const summaries = await workspace.listSessions();
  const newSessionId = await workspace.newSession();
  await workspace.resumeSession(summaries[0]?.id ?? newSessionId);
} finally {
  await workspace.close();
}
```

`SessionStore` contains the complete event histories. `SessionCatalog` is a
separate lightweight index for listing and selecting them; catalog entries are
not appended to model Context. The built-in file Catalog stores a base JSON
snapshot plus append-only operation files and does not compact those operation
files automatically.

`AgentWorkspace` serializes submission and Session mutations, emits
`session.changed`, and keeps catalog summaries current. A product that changes
models or other runtime configuration can use `transitionApplication()` to
open a replacement application on the same Session. It should keep profile
selection and other product state outside the generic workspace.

## History, Context, events, and Catalog

These four data sets are related but not interchangeable:

| Data | Purpose | Durable? | Model-visible? |
| --- | --- | --- | --- |
| Live application/Core events | Streaming UI, progress, approval protocol | No; bounded relays may drop streaming deltas | Not by themselves |
| Session history | Ordered finalized facts and resumable audit trail | Yes, according to the selected store | Replayed facts rebuild Context; presentation metadata is excluded |
| Context | The current request view after selection/compaction | Only when the application records replacement checkpoints | Yes |
| Session Catalog | Small discovery index: id, workspace, title, preview, timestamps | According to the selected catalog | No |

Do not implement a transcript as the source of truth. A UI transcript is a
projection; rebuild it from durable history and then apply live events.

## Shutdown and ownership

The object that owns lower layers must close them:

- a direct Core `RunHandle` can be cancelled, but `May` itself has no close
  method;
- an `AgentApplication` closes its active run/compaction, permission executor,
  and event relays;
- an `AgentWorkspace` closes its active application, serialized state queue,
  catalog-recording tail, and workspace event stream.

Always close in `finally`. Start a long-lived event relay before submitting,
close the owner, and then await the relay so it can observe stream completion.
Do not separately close an application owned by a workspace.

## A practical build checklist

Before calling an Agent product complete, verify that it has explicit answers
for the following:

- **Behavior:** Which instructions are defaults, runtime additions, and
  workspace-controlled additions?
- **Provider:** Where are credentials loaded, and which model limits/content
  forms are supported?
- **Capabilities:** Are tool names unique, inputs parsed, outputs bounded, and
  cancellation forwarded?
- **Safety:** Which calls allow, deny, or ask? What constrains an allowed tool
  beyond the approval prompt?
- **Context:** What is the actual model budget, what triggers compaction, and
  can the Agent retrieve omitted durable history?
- **Persistence:** Is storage in-memory, local single-writer, or a custom
  backend with the required concurrency and encryption guarantees?
- **Events:** Does one continuously running consumer handle approvals and
  terminal failures without treating deltas as authoritative?
- **Sessions:** How are ids discovered, metadata validated, and incompatible
  resumes rejected?
- **Lifecycle:** Who owns cancellation and `close()`, including on startup or
  rendering failure?
- **Product boundary:** Could another UI or provider reuse the headless
  composition without importing application-specific rendering code?

## Related package documentation

- [`@may/core`](../../packages/core/README.md): execution loop, Tool and Model
  contracts, live events, and executor/scheduler seams
- [`@may/application`](../../packages/application/README.md): headless
  single-Session and workspace lifecycle
- [`@may/context`](../../packages/context/README.md): inspection, budgets, and
  compaction strategies
- [`@may/session`](../../packages/session/README.md): durable history, resume,
  local file store, and catalogs
- [`@may/permissions`](../../packages/permissions/README.md): headless policy
  and approval protocol
- [`@may/coding-tools`](../../packages/tools/coding-tools/README.md): bounded
  coding capabilities, instructions, previews, and shell safety boundary
