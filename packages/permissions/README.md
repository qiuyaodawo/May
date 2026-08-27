# `@may/permissions`

`@may/permissions` provides a headless permission layer for May tools. It
implements Core's `ToolExecutor` contract and leaves all terminal or graphical
interaction to the application.

## Usage

```ts
import { May } from "@may/core";
import { PermissionToolExecutor } from "@may/permissions";

const permissions = new PermissionToolExecutor({
  policy({ tool }) {
    if (tool.name === "read") return "allow";
    if (tool.name === "write") return "ask";
    return "deny";
  },
});

const may = new May({ model, tools, context, toolExecutor: permissions });

for await (const event of permissions.events) {
  if (event.type === "approval.requested") {
    const decision = await showApprovalPrompt(event.request);
    permissions.resolve(event.request.id, decision);
  }
}
```

Policies receive validated tool input and execution context. `allow` delegates
to the wrapped executor, `deny` raises `PermissionDeniedError`, and `ask`
suspends execution until `resolve()` receives `allow` or `deny`.

Pending requests are cancelled when their Run signal is aborted. Call
`close()` when the owning application or session ends to reject remaining
requests and close the permission event stream.

## Current scope

The package intentionally has no UI and no global permission registry. The
initial implementation supports one-time decisions only. Persistent rules,
session-scoped grants, and recording approval decisions in `SessionEvent` are
future integration work.
