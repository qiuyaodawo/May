# Custom UI

**English** | [简体中文](../../zh-CN/guides/custom-ui.md)

May's application layer is headless. A terminal, desktop, web, or remote UI
should depend on `AgentController` (one active Session) or
`AgentWorkspaceController` (multiple Sessions), invoke user-intent methods, and
project the asynchronous event stream into view state.

Do not make UI state the source of truth. Complete Session events are durable;
streaming deltas and progress are live observations.

## Headless controller boundary

The primary UI operations are:

```ts
const run = await controller.submit({ input: "Explain this repository" });
run.cancel("Cancelled in UI");       // cancel this handle
controller.cancel("Cancelled in UI"); // cancel the active run or compaction

await controller.resolveApproval(requestId, "allow");
await controller.compactContext();
const history = await controller.history();
```

`submit()` resolves when a run has started, not when it has finished. Observe
`run.result` for completion or failure. Disable conflicting controls while
`controller.isRunning` is true; application and workspace methods also enforce
their idle-only transitions.

Always call `close()`. Closing cancels active work, rejects pending approvals,
waits for event relays, and then closes the event stream.

## Projecting application events

This bridge fills `@may/tui`'s reusable transcript without coupling the
controller to terminal input:

```ts
import type {
  AgentApplicationEvent,
  AgentController,
} from "@may/application";
import type {
  ApprovalDecision,
  ApprovalRequest,
} from "@may/permissions";
import { TranscriptStore } from "@may/tui/transcript";

type AskApproval = (
  request: ApprovalRequest,
) => Promise<ApprovalDecision>;

export async function projectApplication(
  controller: AgentController<AgentApplicationEvent>,
  store: TranscriptStore,
  askApproval: AskApproval,
): Promise<void> {
  store.loadHistory(await controller.history());

  for await (const event of controller.events) {
    switch (event.type) {
      case "run.event":
        store.applyMayEvent(event.event);
        break;
      case "permission.event":
        store.applyPermissionEvent(event.event);
        if (event.event.type === "approval.requested") {
          let decision: ApprovalDecision = "deny";
          try {
            decision = await askApproval(event.event.request);
          } finally {
            await controller.resolveApproval(event.event.request.id, decision);
          }
        }
        break;
      case "context.compacted":
        store.appendNotice("info", `Context compacted by ${event.strategy}`);
        break;
      case "context.compaction.failed":
        store.appendNotice("warning", event.error.message);
        break;
      case "tool.presentation":
        // The application owns this namespaced/versioned display schema.
        // Decode recognized kinds here and update the corresponding tool item.
        break;
    }
  }
}
```

If an approval dialog fails, this example denies the call rather than leaving
the run suspended. `resolveApproval()` returns `false` when the request is
already gone, for example after cancellation.

For an `AgentWorkspaceController`, also handle `session.changed`: reset or load
the new `controller.history()` before applying later live events. Product
extension events are likewise translated in the product UI bridge.

## Retained terminal rendering

`@may/tui` provides terminal primitives, but it is not required by a graphical
UI. A minimal retained transcript is:

```ts
import {
  FullscreenRenderer,
  NodeTerminalDriver,
  TuiRuntime,
} from "@may/tui";
import { TranscriptStore, TranscriptView } from "@may/tui/transcript";

const store = new TranscriptStore();
const view = new TranscriptView(store, { assistantLabel: "My Agent" });
view.setFocused(true);

const terminal = new NodeTerminalDriver();
const renderer = new FullscreenRenderer(terminal);
const runtime = new TuiRuntime({ terminal, renderer, root: view });
const unsubscribe = store.subscribe(() => runtime.requestRender());

runtime.start();
try {
  await projectApplication(application, store, showApprovalDialog);
} finally {
  unsubscribe();
  runtime.stop();
}
```

The application must close for `projectApplication()` to finish normally. In a
real product, an editor or command component initiates `submit()` and the exit
path calls `application.close()` before awaiting the projection task.

`TranscriptView` renders standard coding tools with its default registry and
unknown tools with a generic renderer. Register product renderers on a
`ToolRendererRegistry` instance and pass it in the view options; there is no
global UI registry.

Use `NodeTerminalDriver` for a raw-mode retained screen. Use
`createNodeTerminal()` from `@may/tui/node-terminal` for a line-oriented prompt
UI. They own different input modes and should not control the same terminal at
the same time.

## Event consistency

Application queues may discard high-volume streaming deltas under buffer
pressure while retaining lifecycle events. A UI must therefore:

- replace streamed assistant text with the complete `model.completed` message;
- treat tool progress as transient;
- reload `history()` after resume or when recovering from a disconnected UI;
- key run events by `runId` and tool calls by their call IDs, not arrival text;
- render serialized errors without assuming their concrete JavaScript class.

`TranscriptStore` implements those live/final projection rules. Its
`loadHistory()` method reconstructs only durable facts, so a restored screen
may intentionally omit transient progress seen before shutdown.

## Security and shutdown

- Sanitize any terminal text rendered outside May's `Text`, Markdown, or
  transcript components; untrusted control sequences can alter the terminal.
- Do not render approval as granted until its resolution event is observed.
- Never infer authorization from a disabled button; the permission policy is
  the enforcement boundary.
- Bound tool details, diffs, and history pages before sending them over a UI
  transport.
- Restore terminal raw mode and the alternate screen in `finally` by calling
  `runtime.stop()`.
- Remove subscriptions and close the controller when the UI exits.

See [Permission policies](./permission-policy.md),
[Custom tools](./custom-tool.md), and
[Runtime and session boundaries](../architecture/runtime-session.md).

### MCP user interactions

MaybeCode exposes ephemeral `mcp.interaction.requested` / `settled` events,
`getMcpInteractions()` and `respondMcpInteraction(id, response)`. Enable the broker
with `openConfiguredMaybeCode({ mcpInteractions: true })` only when the UI handles
these events concurrently with Runs and resource preparation. Never place answers
behind the Session transition queue. Show the server and trusted owner, validate
forms, require review/consent, and dismiss questions on settlement/deadline. No
automatic browser navigation or form-answer history. See [MCP](./mcp.md#scoped-user-interaction-modern-mrtr).


Also handle host-owned `params.mode === "review"`: `roots`, `sampling.request`,
and `sampling.response`. Display the bounded `data` document as untrusted content.
Roots are read-only; sampling reviews can submit replacement JSON through
`{ action: "accept", content: { json: editedDocument } }`, or omit content to approve
the displayed document. Never auto-approve either sampling stage. Decline/cancel
and settled/deadline handling are the same as forms. No browser, Session submission,
input-history entry or local tool execution is implied by review.

### MCP task controls

Use `listMcpTasks`, `getMcpTask`, `updateMcpTask`, `waitMcpTask`, `cancelMcpTask`
and `forgetMcpTask` for explicit current-Session controls. Show local handles and
untrusted bounded state, never silently append results to chat. `submitMcpTask`
explicitly prepares a completed result and starts a Run. Task input shares the
interaction events above and retains the originating owner after restart; answer
outside the transition queue. Distinguish local abort, remote cancellation intent
and observed terminal state. Retrying abandoned/expired input requires explicit
`retryAbandonedInputs: true` and fresh review, not automatic resubmission. See
[tasks](./mcp-tasks.md) for budgets, commands and recovery restrictions.

Graphical hosts can use `pool.openApp`, `mcpAppSandboxResponse` and the browser-only
`@may/mcp/apps-browser` entry point. See [isolated Apps](./mcp-apps.md) for consent,
origin/CSP requirements and unsupported APIs. Terminals retain text fallback.
