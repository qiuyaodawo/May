# `@may/permissions`

`@may/permissions` provides a headless permission layer for May tools. It
implements Core's `ToolExecutor` contract and leaves all terminal or graphical
interaction to the application.

## Usage

```ts
import { May } from "@may/core";
import { PermissionToolExecutor } from "@may/permissions";

const permissions = new PermissionToolExecutor({
  policy({ tool, input }) {
    if (tool.name === "read") return "allow";
    if (tool.name === "write") {
      return { decision: "ask", grantKey: `write:${JSON.stringify(input)}` };
    }
    return "deny";
  },
});

const may = new May({ model, tools, context, toolExecutor: permissions });

for await (const event of permissions.events) {
  if (event.type === "approval.requested") {
    const decision = await showApprovalPrompt(event.request);
    await permissions.resolve(event.request.id, decision);
  }
}
```

Policies receive validated tool input and execution context. `allow` delegates
to the wrapped executor, `deny` raises `PermissionDeniedError`, and `ask`
suspends execution until `resolve()` receives `allow`, `allow-session`,
`allow-persistent`, or `deny`. Persistent approval is available only when a
rule store and a trusted policy scope are configured.

Final tool arguments are recursively frozen before policy evaluation and
execution. Policies and approval handlers receive an independent frozen input
snapshot and frozen tool-definition data. They must derive decisions and grant
keys without modifying those values. The actual execution input preserves its
custom class prototype; the policy snapshot uses `structuredClone()` and must
support structured cloning.

When migrating mutable arguments, use ISO strings or timestamps for `Date`,
records or entry arrays for `Map`, arrays for `Set`, number arrays or external
resource identifiers for buffers, and strings or plain data fields for URLs.
`Date`, `Map`, `Set`, `WeakMap`, `WeakSet`, `ArrayBuffer`, `SharedArrayBuffer`,
typed arrays, `DataView`, `URL`, and `URLSearchParams` are rejected before policy
evaluation. Custom classes retain their own property structure and must protect
private fields, accessor state, and inherited mutable state themselves. A tool
or executor can create an independent local working copy of ordinary data with
`structuredClone(input)`.

`allow-session` is accepted only when the policy supplies an explicit
`grantKey`. Reusing that key skips later prompts. Grants also bind to the tool
name, description, canonical input schema, optional `permissionVersion`, and
the policy's persistent `scopeId` when provided. Use one executor per Session;
sharing an executor also shares its in-memory grants.

Use `revokeSessionGrant(grantKey)` to remove a grant before the executor closes.
It removes every definition and persistent scope stored under that grant key.
The optional event sink is awaited before approval execution continues, which
allows Session to preserve durable event order:

```ts
permissions.setEventSink((event) => session.recordPermissionEvent(event));
```

The optional `beforeCheck(check)` callback receives the immutable check once per
tool execution, before policy evaluation. Hosts can use it for durable previews.
Policy is reevaluated during approval and rule-use checks; the callback is not
repeated during those checks or host rule management. Callback failure stops
execution.

`resolve()` and `close()` therefore return Promises.

Pending requests are cancelled when their Run signal is aborted. Call
`close()` when the owning application or session ends to reject remaining
requests and close the permission event stream.

Pass the same optional Core `tracer` used by the surrounding runtime to record
`may.permission.check` and `may.permission.approval_wait` beneath each tool
span. Only the decision and content-free tool/call identifiers are recorded;
the policy input is not captured. `AgentApplication` wires this automatically.

## Persistent rules

The host chooses storage, scope identities, and the trusted approving user. The
Node.js file store is exported from `@may/permissions/file-store`; the default entry
contains the executor, public types, and `InMemoryPermissionRuleStore` without
Node.js filesystem imports.

```ts
import { join } from "node:path";
import { PermissionToolExecutor } from "@may/permissions";
import { FilePermissionRuleStore } from "@may/permissions/file-store";

const ruleStore = await FilePermissionRuleStore.open({
  path: join(projectDirectory, ".may", "permission-rules.json"),
});
const permissions = new PermissionToolExecutor({
  ruleStore,
  policy({ tool }) {
    if (tool.name !== "write_documentation") return "deny";
    // 这些身份由宿主配置提供；工具负责校验 docs 中的 Markdown 路径。
    return {
      decision: "ask",
      grantKey: "docs-markdown:v1",
      persistent: {
        scopeId: JSON.stringify([projectIdentity, userIdentity, agentIdentity]),
        description: "Allow this agent to edit Markdown files under project docs",
      },
    };
  },
});

// 审批身份来自已认证的宿主用户。
await permissions.resolve(request.id, "allow-persistent", {
  createdBy: authenticatedUser.id,
});
await permissions.close();
await ruleStore.close();
```

`ScopedPermissionDecision` supports `allow`, `deny`, and `ask` together with a
nonempty `grantKey` and optional `persistent: { scopeId, description }`.
`scopeId` must encode all required project, user, and agent boundaries using
trusted host data. `grantKey` identifies a validated operation range; keep its
meaning stable and change `permissionVersion` when that meaning changes.
`description` is the complete user-visible range. Do not derive identity from
model arguments or put credentials or file contents in these fields.

Set `requireApproval: true` on an `ask` decision to require a fresh one-time
approval. Such requests expose neither a session grant key nor persistent
approval metadata. Persistent deny rules still apply.

`ApprovalRequest.persistent` contains `scopeId`, `description`, and the current
`definitionKey`. Offer `allow-persistent` only when this metadata exists.
`resolve(id, decision, options?)` requires `options.createdBy` for persistent
approval and accepts an optional future `expiresAt` in epoch milliseconds.
`PersistentApprovalOptions` and `ApprovalResolveOptions` describe these
options. Omitting expiry retains the rule until the host revokes it.

Trusted host management uses:

- `createRule(check, { decision, createdBy, expiresAt? })`: reevaluate policy
  against an immutable check and save an allow or deny rule for its trusted
  scope; an allow rule requires a policy that permits persistent grants.
- `listRules(scopeId?)`: list saved rules, including expired rules for review.
- `createRuleFrom(sourceId, options)`: create an allow or deny rule using the
  trusted operation range of an existing saved rule, a new identifier, and the
  authenticated management user's identity and optional expiry. It accepts no
  external scope or tool-definition fields.
- `revokeRule(id)`: remove a rule and return whether it existed.
- `permissionDefinitionKey(tool)`: compute the canonical identity used for
  definition matching.

`PermissionRuleStore` defines asynchronous `list(scopeId?)`, `create(rule)`, and
`revoke(id)` methods. Hosts may supply a database implementation. A
`PersistentPermissionRule` stores `id`, `scopeId`, `toolName`, `definitionKey`,
`grantKey`, `description`, `decision`, `createdAt`, `createdBy`, and optional
`expiresAt`. The rule contains no original tool arguments. Rule management is a
host capability and must require an authenticated management action.

The executor evaluates policy on each call, checks active matching deny rules,
then checks persistent allows and session grants when policy asks. Denies take
precedence over policy allows, persistent allows, and session grants. Matching
requires the same scope, grant key, tool name, complete definition, and active
expiry. Changing a tool definition or `permissionVersion` invalidates previous
rules. The executor reads the store for each check and rechecks policy and
rules after waiting for approval or recording a rule-use event.

Persistent approval saves the rule and its events before starting the tool.
Store read/validation/write failures and event-sink failures stop execution;
there is no automatic approval on failure. A successfully saved rule remains
saved if a later event fails or the current run is cancelled. Hosts can inspect
and revoke it. Revocation affects later checks and does not cancel a tool that
has already started.

## File-store ownership and events

`FilePermissionRuleStore.open({ path })` creates a versioned JSON file when it
does not exist, validates existing data, and acquires an exclusive
`<path>.lock`. It reads current file contents on every operation, serializes
operations, and replaces files atomically after flushing the temporary file.
The parent directory is also flushed where Node.js supports it. Invalid data,
unsupported versions, symbolic links, and multiple file links are rejected.
A failed file read or write prevents subsequent storage access.

One file store owns each path at a time. Applications may share that store
among executors for the same local process. The owner must close its executors
before calling `ruleStore.close()` to release the writer lock. Executor
`close()` does not close an injected store. A retained lock after an interrupted
process requires host verification of its recorded PID/hostname before manual
cleanup; the store does not automatically remove an existing lock.

Local hosts can use `<project>/.may/permission-rules.json`; add this private
authorization data to `.gitignore`. Long-running hosts can use
`<data-directory>/permission-rules.json` and include their user/project/agent
identities in `scopeId`. `@may/permissions` has no global storage path.

Alongside approval events, `PermissionEvent` emits `rule.created { rule }`,
`rule.revoked { ruleId, scopeId }`, and
`rule.used { ruleId, scopeId, decision, runId, toolCallId }`. Every event carries
`seq` and `timestamp`, and the optional sink is awaited. Session records these
events; rules themselves are restored from the configured rule store. Pending
approvals continue to use Session recovery and are not stored as permission
rules.
