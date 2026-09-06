# Permission policies

**English** | [简体中文](../../zh-CN/guides/permission-policy.md)

`@may/permissions` is a headless authorization and approval layer around tool
execution. A `PermissionPolicy` receives the tool definition, its parsed input,
and execution correlation data, then returns one of:

- `allow` — execute immediately;
- `deny` — reject the call;
- `ask` — suspend for a one-time approval;
- `{ decision: "ask", grantKey }` — suspend and permit an in-memory scoped
  grant when the UI chooses `allow-session`.

Permission is separate from the tool itself so the same capability can be used
under different product policies.

## Default-deny policy

Keep allow rules narrow and use stable, policy-defined grant keys:

```ts
import type { PermissionPolicy } from "@may/permissions";

export const permissionPolicy: PermissionPolicy = ({ tool, input }) => {
  // A pure, bounded operation is safe for this product.
  if (tool.name === "add") return "allow";

  // Require approval for one normalized notification channel.
  if (tool.name === "send_notification") {
    const channel = stringField(input, "channel")?.trim().toLowerCase();
    if (channel === undefined || channel === "") return "deny";
    return {
      decision: "ask",
      grantKey: `send_notification:channel:${channel}`,
    };
  }

  // New tools do not become authorized merely because they were registered.
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

`AgentApplication` relays approval requests as `permission.event` values. A UI
chooses a decision and returns it through the controller:

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
      await application.resolveApproval(request.id, decision);
    }
  }
}
```

Only offer `allow-session` when `request.grantKey` is present. Resolving
`allow-session` without a key throws. `resolveApproval()` returns `false` for an
unknown or already-cancelled request, allowing the UI to dismiss stale dialogs.

An unresolved request waits until the run is cancelled or the permission
executor/application closes. The UI should provide an explicit deny/cancel
path; there is no implicit approval timeout.

## Grant lifetime

Session grants live in one `PermissionToolExecutor` instance. The policy is
evaluated for every call before a stored grant is checked, so a later `deny`
still wins. A matching scoped grant skips only the approval prompt.

`AgentApplication` creates one executor for its active Session and clears it on
close. Current grants are not durable: reopening or resuming a Session creates
a new executor and requires approval again. Do not share a raw executor between
Sessions unless sharing its grants is an intentional product decision.

When using `PermissionToolExecutor` directly, call
`revokeSessionGrant(grantKey)` to remove a scope and `close()` to cancel pending
requests. Connect `setEventSink()` to `Session.recordPermissionEvent()` if the
application assembles Session and permissions without `AgentApplication`.

## Failure semantics

- `deny` produces `PermissionDeniedError`; it is recorded as a failed tool
  result and can be handled by the model.
- A policy exception or approval-event persistence failure becomes a fatal tool
  execution error and terminates the run.
- Cancelling the run cancels its pending request and emits
  `approval.cancelled`.
- Closing the application rejects every pending request and closes the event
  stream.

Do not catch policy failures and default to `allow`. If an external policy
service is unavailable, choose an explicit deny or fail the run.

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
external sandbox when executing untrusted code. May's current permission layer
does not provide a sandbox or durable organization-wide policy service.

See [Custom tools](./custom-tool.md) for capability design and
[Custom UI](./custom-ui.md) for rendering and resolving requests.

Session grants also bind to the tool definition and optional host `permissionVersion`.
See [per-Run catalogs](./custom-tool.md#per-run-dynamic-tool-catalogs).
