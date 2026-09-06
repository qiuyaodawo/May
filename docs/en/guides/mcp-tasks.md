# MCP long-running tasks

**English** | [简体中文](../../zh-CN/guides/mcp-tasks.md)

## Supported boundary

`@may/mcp` and MaybeCode support opt-in task creation, inspection, reviewed input,
waiting, cooperative cancellation and owner-bound recovery over modern stdio and
Streamable HTTP. This targets the
[2026-07-28 Tasks extension](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks),
`io.modelcontextprotocol/tasks`: flat task handles and `tasks/get`, `tasks/update`,
`tasks/cancel`. The incompatible 2025 experimental `tasks/list`/`tasks/result`
protocol is not supported. Optional task subscription notifications are not
implemented; explicit polling is supported. Apps and server export remain separate
[roadmap](../architecture/mcp-host-roadmap.md) phases.

Enable `tasks: true` on an endpoint (default `false`). Both the negotiated core
version `2026-07-28` and server Tasks extension are required; an incompatible
required endpoint fails startup. Stdio defaults to legacy, so also select
`protocolMode: "auto"` for a modern task server. The extension is advertised only
on task-enabled `tools/call` and task-management requests, not globally and not on
resource/prompt requests. Immediate tool results remain supported.

```json
{
  "apps": { "maybecode": { "mcpServers": {
    "jobs": {
      "transport": "streamable-http",
      "url": "https://jobs.example.com/mcp",
      "tasks": true,
      "host": { "sampling": true }
    }
  } } }
}
```

MaybeCode supplies a separate encrypted OS-keyring-backed journal at
`<dataDirectory>/mcp-tasks`. Custom hosts must pass `taskJournal` to
`openMcpClientPool` when enabling Tasks:

```ts
import { KeyringMcpCredentialStore, McpTaskJournal } from "@may/mcp";
const taskJournal = new McpTaskJournal(new KeyringMcpCredentialStore(taskVaultDirectory));
```

An injected secure `McpCredentialStore` is supported. `InMemoryMcpCredentialStore`
deliberately loses recovery on exit. Share one store across all Sessions requiring
ownership isolation; independent stores cannot enforce cross-store ownership.

## User controls and Context

Task creation is a normal MCP tool call through the Core permission/execution
pipeline. A deferred result gives the model only a **local task handle**, not an
invitation to repeat the call. Management APIs are explicit host controls, not
implicitly exposed model tools. Both terminal UIs share these commands:

| Command | Effect |
| --- | --- |
| `/mcp tasks [server]` | List this Session's local metadata; no network |
| `/mcp task-get server local-id` | Fetch and preview current state |
| `/mcp task-wait server local-id` | Poll while working; stop at input-required or terminal |
| `/mcp task-update server local-id` | Review and fulfill current unclaimed inputs |
| `/mcp task-retry-input server local-id` | Explicitly re-review abandoned/expired unacknowledged input |
| `/mcp task-cancel server local-id` | Send cooperative remote cancellation |
| `/mcp task-forget server local-id` | Remove local history only |
| `/mcp task-attach server local-id [question]` | Explicitly attach a completed result to a new Run |

Preview, polling and notifications never append results to Context. Attachment
uses bounded, provenance-labelled user content, preserves multimodal/structured
results and validates the original tool's output schema (`isError` results need
not satisfy a success schema). Previewed server content is untrusted and terminal
output is sanitized. Neither task form answers nor sampling input/output reviews
are placed in Session history.

Pool APIs are `listTasks(owner)`, `getTask`, `updateTask`, `waitTask`, `cancelTask`
(with server id, local id and trusted owner options), and
`forgetTask(serverId, localId, owner)`. `mcpTaskToUserMessage` performs explicit
completed-result adaptation. MaybeCode exposes corresponding `*McpTask` controller
methods plus `listMcpTasks` and `submitMcpTask`; it supplies the current
workspace/Session itself and pins state transitions. UIs must answer interaction
events outside that queue, just as for [Host interactions](mcp.md).

## Ownership, input and cancellation

A write-ahead local record must succeed **before** sending a task-capable call.
The runtime binds the original workspace/Session/Run/tool-call owner, actual
endpoint and authorization identity, protocol version and complete tool definition.
Each later action checks the current binding and catalog. Changing credentials,
destination or tool definition fails closed; merely retaining the same config
alias grants no access. Normal restart reuses a stable identity, never a former
connection's request ids. A received remote handle is persisted even if its Run
has just been cancelled. Unknown initial outcomes remain `starting`/`uncertain`
and are never replayed automatically.

`task-update` uses the existing reviewed form/URL/Roots/Sampling host services.
Roots/Sampling still require explicit Host options and an interaction consumer.
The original owner is retained after restart; task input cannot read Session
history or invoke local tools. Each input key/content fingerprint is claimed
before UI work; submission is recorded before RPC, acknowledgement separately.
Repeated polling does not prompt or bill again. A reused key with changed content
fails closed. Answers themselves are never persisted.

Ordinary update does not retry reserved input. `task-retry-input` (API option
`retryAbandonedInputs: true`) requests a fresh review only for abandoned or expired
unacknowledged claims, using an atomic prior-claim check. It never resets budgets,
replays tool creation, or resends stored answers. Acknowledged input cannot be
retried. A lost update acknowledgement can represent accepted remote input: poll
first, and retry only after understanding that uncertainty. Claims have bounded
operation deadlines; legacy claims without a deadline are not treated as expired.

Waiting defaults to five minutes, configurable up to one day via `waitTask`.
Per-request timeouts still apply. Polling respects the server interval (minimum
250 ms; default one second). Expired TTL fails locally. Ctrl+C, a wait deadline,
connection close or application shutdown stops **local** work only; it does not
send remote cancellation. `task-cancel` records intent and acknowledgement, not a
terminal state: remote completion can win the race. Forgetting does not cancel or
delete remote work. There is no automatic background polling, model invocation,
reconnect/replay or Context attachment after restart.

## Storage, budgets and evidence

Each Session retains at most 64 records / 512 KiB. Initial creation MRTR usage
carries into each task's persistent lifetime budget: 32 host-input attempts
(including retries), four sampling reservations and 16,384 reserved output tokens,
with at most 4,096 per reservation. Approved sampling usage is persisted before
the provider call; cancellation, withheld output and retry never refund it.

Only routing metadata, timestamps, status, cancellation intent and hashed claims
are persisted—not arguments, status messages, input payloads, answers, errors or
results. Remote ids and owner labels are encrypted in the keyring vault. The
cross-Session index retains at most 1,024 hashed remote-id tombstones per endpoint
identity, even after forgetting. Reservation precedes Session binding, so partial
writes leave restrictive tombstones. A full index requires explicit maintenance
after auditing outstanding handles; it is not silently evicted.

`McpTaskJournal` supplies `begin`, `initialUsage`, `observe`, `get`/`list`,
`uncertain`, `claimInput`, `reserveSampling`, `markInput`, `abandonInput`,
`cancelIntent` and `forget`. The journal itself sends no RPC and grants no
permission. `parseMcpTask` validates bounded native frames; the runtime additionally
validates completed tool content/schema. Corruption or an unavailable keyring
fails closed. If a crash leaves a vault `.lock`, verify its recorded PID has exited
before removing that specific stale lock; never reset the vault to justify replay.

The extension channel owns distinct string RPC ids, without accessing private SDK
request maps or fabricating core tool responses. HTTP management requests carry
`Mcp-Name` task routing; tool requests preserve supported `x-mcp-header` routing.
Diagnostics omit server RPC error text and input payloads. Evidence:
`task-journal.test.mjs`, `task-runtime.test.mjs` (HTTP and real stdio process restart,
review/retry, cancellation races, changed identities and output validation), and
MaybeCode's `mcp-capabilities.test.mjs` (permission gate, terminal input and explicit
attachment). These focused fixtures do not claim universal third-party conformance.
