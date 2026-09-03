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
suspends execution until `resolve()` receives `allow`, `allow-session`, or
`deny`.

`allow-session` is accepted only when the policy supplies an explicit
`grantKey`. Reusing that key skips later prompts, but the policy is still
evaluated first so a later `deny` wins. Use one executor per Session; sharing an
executor would also share its in-memory grants.

Use `revokeSessionGrant(grantKey)` to remove a grant before the executor closes.
The optional event sink is awaited before approval execution continues, which
allows Session to preserve durable event order:

```ts
permissions.setEventSink((event) => session.recordPermissionEvent(event));
```

`resolve()` and `close()` therefore return Promises.

Pending requests are cancelled when their Run signal is aborted. Call
`close()` when the owning application or session ends to reject remaining
requests and close the permission event stream.

Pass the same optional Core `tracer` used by the surrounding runtime to record
`may.permission.check` and `may.permission.approval_wait` beneath each tool
span. Only the decision and content-free tool/call identifiers are recorded;
the policy input is not captured. `AgentApplication` wires this automatically.

## Current scope

The package intentionally has no UI and no global permission registry. Grants
live only for the lifetime of one executor. Persistent rules are future work.
