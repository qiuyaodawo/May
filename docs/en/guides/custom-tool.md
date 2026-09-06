# Custom tools

**English** | [简体中文](../../zh-CN/guides/custom-tool.md)

A May tool is one named capability exposed to a model. The `Tool` contract from
`@may/core` separates three concerns:

- `inputSchema` describes the call to the model;
- optional `parse()` validates and converts untrusted model output;
- `execute()` performs the operation.

`ToolRegistry` provides instance-scoped composition and lookup. There is no
process-global tool registry: each definition, application, or Core runtime
receives an `Iterable<Tool>` and snapshots its membership at the appropriate
construction boundary.

## A complete tool

```ts
import type { Tool } from "@may/core";

interface AddInput {
  readonly left: number;
  readonly right: number;
}

interface AddOutput {
  readonly value: number;
}

export const addTool: Tool<AddInput, AddOutput> = {
  name: "add",
  description: "Add two finite numbers.",
  inputSchema: {
    type: "object",
    properties: {
      left: { type: "number" },
      right: { type: "number" },
    },
    required: ["left", "right"],
    additionalProperties: false,
  },

  parse(input): AddInput {
    if (typeof input !== "object" || input === null) {
      throw new TypeError("add input must be an object");
    }
    const value = input as Record<string, unknown>;
    if (!Number.isFinite(value.left) || !Number.isFinite(value.right)) {
      throw new TypeError("left and right must be finite numbers");
    }
    return { left: value.left as number, right: value.right as number };
  },

  async execute(input, context): Promise<AddOutput> {
    context.signal.throwIfAborted();
    context.report({ type: "progress", message: "Adding values" });
    return { value: input.left + input.right };
  },
};
```

Compose it with other capabilities, then capture the composition in an Agent
definition:

```ts
import { defineAgent } from "@may/application";
import { ToolRegistry } from "@may/core";

const tools = new ToolRegistry([addTool]);
tools.registerAll(productTools);

const agent = defineAgent({
  model,
  tools,
  permissionPolicy,
});

const application = await agent.open({ store });
```

`inputSchema` is sent to the model; it is not a runtime validator. Always
validate in `parse()` (or inside `execute()` if no separate parser is useful).
The permission policy receives the parsed value.

## Registry composition and lookup

`ToolRegistry` implements `Iterable<Tool>` and retains insertion order. Its
complete collection API is:

```ts
const registry = new ToolRegistry(baseTools);

registry.register(tool);
registry.registerAll(featureTools);

registry.size;
registry.has("add");
registry.get("add");       // Tool | undefined
registry.require("add");   // Tool, or ToolNotFoundError
registry.names();          // insertion-ordered string snapshot
registry.values();         // insertion-ordered Tool snapshot
registry.definitions();    // model-facing definitions, no execute/parse

const independent = registry.clone();
const composed = ToolRegistry.compose(baseTools, featureTools);
for (const registeredTool of composed) {
  console.log(registeredTool.name);
}
```

The constructor and registration methods validate the Tool shape. Duplicate
names throw `DuplicateToolNameError`. `registerAll()` is atomic: if any member
is invalid, repeats another incoming name, or conflicts with an existing name,
none of that group is registered. `register()` delegates to the same rule.
`clone()` and `compose()` create independent registries; they do not mutate a
source registry.

Collection snapshots preserve the original Tool object identity rather than
cloning executable objects. This allows product metadata keyed by Tool identity
(for example, a `WeakMap<Tool, Metadata>`) to keep working across composition.
The Tool's `name`, `description`, and `inputSchema` fields are readonly in
TypeScript; those fields plus `parse` and `execute` must remain stable after
registration. When returning tools or model definitions, a registry checks the
registered `name`, `description`, `inputSchema` reference, `parse`, and
`execute`; changing one causes `TypeError`. The check is shallow—the schema
object is not deep-frozen—so treat its contents as immutable too. Create new
Tool objects when an application needs different per-Session descriptors or
state.

`May` consumes any tool iterable and snapshots it in the constructor.
`defineAgent()` consumes and snapshots its iterable when the definition is
created, before any application is opened. Direct `AgentApplication.open()`
accepts an iterable and snapshots it while opening. Consequently, registering
a tool later affects none of those existing owners:

```ts
const tools = new ToolRegistry([addTool]);
const agent = defineAgent({ model, tools, permissionPolicy });

tools.register(subtractTool); // available in tools, not in agent
const application = await agent.open({ store });
```

## Execution context

Every call receives a `ToolExecutionContext`:

- `runId`, `step`, and `toolCallId` correlate events;
- `idempotencyKey` is stable for that call and should be used when an external
  API supports deduplication;
- `signal` cancels the operation with its owning run;
- `report()` emits live `output.delta` or structured `progress` updates.

Progress is not durable Session history. Return the complete result from
`execute()` and do not rely on a UI retaining every delta.

For long-running work, forward `signal` into every cancellable dependency and
check it between non-cancellable stages:

```ts
async execute(input, context) {
  const response = await fetch(input.url, { signal: context.signal });
  context.signal.throwIfAborted();
  return { status: response.status, body: await response.text() };
}
```

If a side effect may have committed before cancellation, the tool must define
its own recovery or idempotency behavior. May cannot roll external effects
back.

## Failure semantics

A validation or ordinary execution error becomes a `tool.failed` event and an
error tool message. The model can inspect that result on the next step and
recover. Throw `FatalToolExecutionError` only when continuing the run would be
unsafe, such as a broken authorization or persistence boundary.

An aborted run is different from an ordinary tool failure. Once the signal is
aborted, stop producing progress and exit promptly. Core records terminal
results for calls that were cancelled before completion so resumed history
does not contain unmatched tool calls.

Tool names must be unique within a runtime. `May` rejects duplicates. If
`AgentApplication` is configured with the optional `session_history` tool,
that name is reserved by the application.

Core uses the sequential scheduler by default. Only opt into
`parallelToolScheduler` when every tool selected in the same model response is
safe to run concurrently and their results remain meaningful in call order.

## Security boundary

A tool is executable application code, not a sandbox:

- treat model arguments as hostile input;
- bound input size, output size, runtime, retries, and resource use;
- canonicalize filesystem paths and defend against links when enforcing a
  workspace boundary;
- avoid returning credentials or sensitive environment data because tool
  results become model-visible and durable history;
- use least-privilege clients for network and database access;
- place user authorization in a separate permission policy.

Approval controls whether a capability may run; it does not restrict what the
process can access after approval. See
[Permission policies](./permission-policy.md).

For workspace-safe file and shell implementations, prefer the factories in
`@may/coding-tools`. Its shell tool executes with the May process's privileges
and is explicitly **not** a sandbox.

## Testing boundary

Test `parse()` and `execute()` without a model first. Use an
`AbortController`, a fixed execution context, and capture `report()` calls.
Then add one runtime-level test proving that the normalized output is returned
to the model. Provider behavior does not need to be retested by every tool.

See also [Custom model adapters](./custom-model.md) and
[Custom UI](./custom-ui.md).

## Per-Run dynamic tool catalogs

`MayOptions.toolSource`, also forwarded by `AgentApplication`, `defineAgent()`
and `MaybeCodeApplication`, is a trusted synchronous `() => Iterable<Tool>`.
It adds to static `tools`; it is called exactly once at each `run()` or
`continue()` start, not on every model step. Duplicate names fail before Context
mutation. Fetch/discover remote catalogs outside Core and publish their latest
in-memory snapshot through this callback.

`ToolRegistry.snapshot()` captures a frozen Tool facade and a deep-copied,
frozen schema. A Run uses the same snapshot for model definitions, scheduler,
parser, permissions and execution. Model-facing schemas are separate copies.
Updates affect only the next Run. Ordinary registry lookup/`clone()` still
preserve original Tool identity, but executors receive the Run facade: attach
host metadata as Tool fields, not only in an identity-keyed WeakMap. Captured
callbacks retain their original `this`; this is not a sandbox or a deep clone
of arbitrary closure state. Tool schema values must support structured cloning.

`Tool.permissionVersion` is optional host-owned grant identity, omitted from
model definitions. Permission session grants are now bound to canonical name,
description, input schema and this version as well as the policy's `grantKey`.
Changed definitions or host identity require new approval even with the same
key. Equivalent schema key order does not. `revokeSessionGrant(key)` revokes all
versions under that key; explicit policy deny still wins. Host adapters should
include other execution-affecting fields and endpoint/account in their version.

`Tool.resultContent(output)` optionally projects successful output to model-visible
`ContentPart[]`, instead of the default JSON block. It is captured by Run snapshots.
Raw output remains in `tool.completed`; projection errors become tool failures.
Validate untrusted content and omit host-only metadata from the projection.
