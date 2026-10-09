# Configure tool permissions and approvals

**English** | [简体中文](../../zh-CN/guides/permission-policy.md)

Use this guide to decide which tools execute immediately, which require
approval, and which grants survive a restart. Add `@may/permissions` to the
application's direct dependencies and configure tool input validation before
adding a policy. The application and its event consumer are described in
[Build an Agent](building-an-agent.md).

`PermissionPolicy` receives the tool definition, parsed input, and execution
identifiers. Its return value selects the authorization behavior:

- `allow` — execute immediately;
- `deny` — reject the call;
- `ask` — suspend for a one-time approval;
- `{ decision: "ask", grantKey }` — suspend and permit an in-memory scoped
  grant when the UI chooses `allow-session`;
- `{ decision, grantKey, persistent: { scopeId, description } }` — define a
  trusted persistent scope for an `allow`, `deny`, or `ask` decision. When an
  `ask` request has a configured rule store, the UI can offer `allow-persistent`;
- an `ask` decision with `requireApproval: true` — require a fresh one-time
  approval, while continuing to enforce matching persistent deny rules.

Permission is separate from the tool itself so the same capability can be used
under different product policies.

## Default-deny policy

Create a policy module and allow only the operation ranges your product
supports. This example assumes registered `add` and `send_notification` tools:

```ts
import type { PermissionPolicy } from "@may/permissions";

export const permissionPolicy: PermissionPolicy = ({ tool, input }) => {
  // 允许本产品支持的有限加法操作。
  if (tool.name === "add") return "allow";

  // 为指定通知渠道请求审批。
  if (tool.name === "send_notification") {
    const channel = stringField(input, "channel")?.trim().toLowerCase();
    if (channel === undefined || channel === "") return "deny";
    return {
      decision: "ask",
      grantKey: `send_notification:channel:${channel}`,
    };
  }

  // 新工具需要明确授权。
  return "deny";
};

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}
```

The policy runs after `Tool.parse()`, so it normally sees validated input.
Still fail closed if a required authorization field is absent. `inputSchema`
alone is not runtime validation.

A grant key is an authorization scope, not a display label. Do not use a broad
key such as `write` when the intended grant is one file or directory. Avoid raw
JSON when insignificant ordering or secret fields would make unstable or
sensitive keys.

## Approval protocol

`AgentApplication` relays approval requests as `permission.event` values. Add
approval handling to the application's existing event consumer. The following
function shows only the approval part; the host supplies `choose` and its
authenticated `createdBy` identity. A full UI must handle the other event types
in the same consumer or explicitly distribute them to separate queues:

```ts
import type { AgentApplication } from "@may/application";
import type {
  ApprovalDecision,
  ApprovalRequest,
} from "@may/permissions";

type Choose = (request: ApprovalRequest) => Promise<ApprovalDecision>;

export async function serveApprovals(
  application: AgentApplication,
  choose: Choose,
  createdBy: string,
): Promise<void> {
  for await (const event of application.events) {
    if (
      event.type !== "permission.event" ||
      event.event.type !== "approval.requested"
    ) {
      continue;
    }

    const request = event.event.request;
    let decision: ApprovalDecision = "deny";
    try {
      decision = await choose(request);
    } finally {
      await application.resolveApproval(
        request.id,
        decision,
        decision === "allow-persistent" ? { createdBy } : undefined,
      );
    }
  }
}
```

Only offer `allow-session` when `request.grantKey` is present. Offer
`allow-persistent` when `request.persistent` is present and show its complete
`description`. The trusted host supplies `createdBy` from the authenticated
user; model arguments and unauthenticated UI fields cannot provide that identity.
An optional `expiresAt` uses future epoch milliseconds. Invalid approval
choices throw. `resolveApproval()` returns `false` for an unknown, resolving, or
already-cancelled request, allowing the UI to dismiss stale dialogs.

An unresolved request waits until the run is cancelled or the permission
executor/application closes. The UI should provide an explicit deny/cancel
path; there is no implicit approval timeout.

## Persistent scope and storage

This composition snippet requires a registered `write_documentation` tool that
validates project Markdown paths, and trusted host values for `projectDirectory`,
`projectIdentity`, `userIdentity`, and `agentIdentity`:

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
    // 宿主提供可信身份；write_documentation 校验 docs 中的 Markdown 路径。
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
```

The host owns all identities and resource-range validation. A stable `scopeId`
must distinguish every required user, project, and agent. A `grantKey` names a
validated range of equivalent operations, and `description` presents that range
to the user. Avoid credentials, file contents, and raw tool arguments in these
fields. File policies and tools must resolve their filesystem boundary and
validate symbolic links before offering a directory-level grant.

The store path is supplied by the host. Local projects can use
`<project>/.may/permission-rules.json`; add private authorization data to
`.gitignore`. Long-running hosts can use
`<data-directory>/permission-rules.json`, with identity boundaries encoded in
`scopeId`. The default package entry also exports
`InMemoryPermissionRuleStore`. Custom implementations of `PermissionRuleStore`
provide asynchronous `list(scopeId?)`, `create(rule)`, and `revoke(id)` methods.

Each `PersistentPermissionRule` stores `id`, `scopeId`, `toolName`,
`definitionKey`, `grantKey`, `description`, `decision`, `createdAt`, `createdBy`,
and optional `expiresAt`. It does not store the original tool arguments.
`permissionDefinitionKey(tool)` canonicalizes the tool name, description,
`inputSchema`, and optional host `permissionVersion`; equivalent schema-property
ordering preserves the identity. Change `permissionVersion` whenever the
operation range, account, output semantics, or other authorization-relevant
behavior changes. A different definition invalidates existing grants.

The executor evaluates policy and reads the configured store on every relevant
check. A policy denial stops immediately. Matching active persistent deny rules
override policy allows, persistent allows, and session grants. Persistent allows
can satisfy `ask` only when scope, grant key, tool name, definition, and expiry
all match. `requireApproval: true` on `ask` suppresses session and persistent
allow reuse and exposes neither `grantKey` nor persistent metadata in the
approval request.

`allow-persistent` saves the rule and awaits permission events before execution.
After pending approvals and rule-use events, the executor checks the current
policy and rules again. Changed scope, revoked grants, expiry, and new denials
prevent authorization from an earlier request. Rule revocation affects future
checks; tools already running retain their existing cancellation behavior.

## Host rule management

`PermissionToolExecutor` exposes trusted management methods:

- `createRule(check, { decision, createdBy, expiresAt? })` reevaluates current
  policy against an immutable `PermissionCheck` and derives its trusted scope.
  Persistent allow creation requires a policy that permits persistent grants.
- `createRuleFrom(sourceId, options)` copies the trusted range of a currently
  saved rule and creates a new allow or deny rule with a new identifier,
  timestamp, approving user, and optional expiry. External scope and
  tool-definition fields are never accepted by this operation.
- `listRules(scopeId?)` returns saved rules, including expired rules for review.
- `revokeRule(id)` removes a rule and returns whether it existed.

The application methods are `createPermissionRule`,
`createPermissionRuleFrom`, `listPermissionRules`, and `revokePermissionRule`.
These methods belong to authenticated host management. Agent tools must not
create or edit permission rules automatically. Rejecting one approval denies
that call; saving a persistent denial requires an explicit management action.

`FilePermissionRuleStore.open({ path })` validates a versioned JSON file,
initializes a missing file, and acquires an exclusive `<path>.lock`. It
serializes operations, reads current content on each operation, and flushes a
temporary file before atomically replacing the rule file. Parent-directory
flush is performed where supported by Node.js. Unsupported formats, symbolic
links, and files with multiple links fail validation. Read or write failure
prevents further access through that store instance.

One file store owns each path. Share that instance among local executors that
use the same file. Close all owning executors before `await ruleStore.close()`;
executor `close()` leaves an injected store under host ownership. An existing
writer lock prevents opening a second owner. After an interrupted process, the
host must verify the recorded PID/hostname before manually removing its retained
lock; the store does not automatically remove it.

## Grant lifetime

Session grants live in one `PermissionToolExecutor` instance and bind to their
grant key, complete tool definition, and any persistent `scopeId`. A matching
scoped grant skips the approval prompt while preserving policy and deny checks.

`AgentApplication` creates one executor for its active Session and clears it on
close. Reopening a Session creates a new executor and clears session grants.
Configured persistent rules remain available across executors and restarts.
Share a raw executor between Sessions only when shared session grants are an
intentional product decision.

When using `PermissionToolExecutor` directly, call
`revokeSessionGrant(grantKey)` to remove every definition and persistent scope
stored under that session grant key, and `close()` to cancel pending
requests. Connect `setEventSink()` to `Session.recordPermissionEvent()` if the
application assembles Session and permissions without `AgentApplication`.

## Failure semantics

`PermissionToolExecutor({ beforeCheck })` can prepare a durable tool preview
from the immutable check once per tool execution. Rechecking policy after an
approval or rule-use event does not repeat this callback. Host rule management
also excludes it. `AgentApplication` uses this callback for
`createToolPresentation`; preparation failures stop the operation.

- `deny` produces `PermissionDeniedError`; it is recorded as a failed tool
  result and can be handled by the model.
- A policy exception, rule-store read/validation/write failure, or permission
  event persistence failure becomes a fatal tool execution error and terminates
  the run.
- Cancelling the run cancels its pending request and emits
  `approval.cancelled`.
- Closing the application rejects every pending request and closes the event
  stream.
- Rules already saved remain saved when a subsequent event fails or the current
  run is cancelled. The host can inspect and revoke them.

Permission events include `rule.created { rule }`,
`rule.revoked { ruleId, scopeId }`, and
`rule.used { ruleId, scopeId, decision, runId, toolCallId }`, each carrying `seq`
and `timestamp`. The sink is awaited before execution continues. Session records
these events; rule restoration reads the configured store. Pending approvals
use Session recovery and do not become stored rules.

Do not catch policy failures and default to `allow`. If an external policy
service is unavailable, choose an explicit deny or fail the run.

## Verify persistent approval

The real-provider MaybeCode check is opt-in. After `pnpm build`, set
`MAYBECODE_PERSISTENT_RULES_LIVE=1` and optionally
`MAYBECODE_PERSISTENT_RULES_MODEL=<configured-profile>`, then run
`node --test apps/maybecode/test/integration/persistent-rules.test.mjs`.
The current user configuration supplies the actual provider. Two writes target
one isolated file, with the Session and executor closed and reopened between
them. The check verifies one persistent approval, rule creation/use in history
and permission evidence remaining outside model Context. Each Run permits at
most three model calls and 45 seconds. Retries, Git, MCP, Skills, Goals and
subagents are disabled. Saved evidence remains under the ignored
`review/persistent-rules` directory; ordinary offline runs skip the check.

## Security boundary

Permissions answer **whether** a tool may execute. They do not constrain
**what the process can affect** after it executes:

- `allow` and approved calls still run with the tool's OS/network credentials;
- a path grant does not defend against symbolic links unless the tool validates
  its filesystem boundary;
- a command preview is display metadata, not proof that execution will have the
  same effects;
- approval events and inputs may contain sensitive data and are persisted by
  `AgentApplication` Session history.

Use defense in depth: a narrow tool API, strict parsing, least-privilege
credentials, resource limits, workspace-safe filesystem handling, and an
external sandbox when executing untrusted code. Hosts own sandbox setup and
organization-wide policy services.

See [Custom tools](./custom-tool.md) for capability design and
[Custom UI](./custom-ui.md) for rendering and resolving requests.

See [per-Run catalogs](./custom-tool.md#per-run-dynamic-tool-catalogs) for
host-owned tool versioning.
