# MCP task persistence

**English** | [简体中文](../../zh-CN/guides/mcp-tasks.md)

## Current implementation boundary

`@may/mcp` provides the task-frame parser and durable ownership journal described
below. **The client pool does not yet advertise Tasks, create remote task handles,
poll, update, cancel or expose task commands in MaybeCode.** Storage groundwork
is not end-to-end Tasks support; runtime integration remains unchecked in the
[roadmap](../architecture/mcp-host-roadmap.md).

This API targets the [2026-07-28 Tasks extension](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks),
identified as `io.modelcontextprotocol/tasks`. That wire format uses a flat task
handle and `tasks/get`, `tasks/update`, `tasks/cancel`, rather than the incompatible
2025 experimental `tasks/list`/`tasks/result` lifecycle. Extension support must
eventually be negotiated separately from core protocol support.

## Storage API

```ts
import { KeyringMcpCredentialStore, McpTaskJournal } from "@may/mcp";

// Use a separate vault directory; its encryption key is stored in the OS keyring.
const journal = new McpTaskJournal(new KeyringMcpCredentialStore(taskVaultDirectory));
const records = await journal.list({ workspaceId, sessionId });
```

The journal reuses the transactional `McpCredentialStore` port, not OAuth records.
An injected secure store works for custom hosts; `InMemoryMcpCredentialStore`
deliberately loses task recovery on process exit. One shared store must serve all
Sessions whose task ownership needs isolation. Independent stores cannot enforce
cross-store ownership.

- `begin(owner, binding)` writes a host-generated local handle **before** any
  task-capable call. Failure must prevent the send. The caller supplies the trusted
  workspace/Session/Run/tool-call owner, protocol version, server/tool names, opaque
  endpoint/authorization identity and complete tool-definition hash. The endpoint
  identity must be stable across restart, identify the actual destination and
  authorization grant (not just a config alias), and change when that identity
  changes. The journal does not discover or authenticate these identities itself.
- `observe(..., raw, "created" | "state")` validates and binds metadata. Later
  polls must preserve the remote id/creation time; timestamps cannot go backwards
  and terminal states cannot change. A state poll cannot bind a previously unknown
  handle. A cross-Session ownership index prevents remote-id reuse, even after
  local history is forgotten. The host still validates final tool output against
  the original definition before using it.
- `get` requires the current binding and Session; `list` reads only the local
  Session partition. Neither makes remote calls. `uncertain` records an unknown
  initial outcome without authorizing replay. A recovered `starting` record can
  also represent a crash window; do not interpret it as safe to send again.
- `claimInput` atomically reserves a unique key/content fingerprint before UI or
  model work; concurrent/repeated polls do not obtain a second claim. Changed
  content under an existing key fails closed. Callers must only claim keys from
  a validated current task response. `reserveSampling` persists approved usage
  before a provider call, once per claim. `markInput("submitted")` precedes
  `tasks/update`; acknowledgement is recorded separately. Neither answers nor
  model output are stored. Interrupted claims remain reserved after restart;
  they must not silently prompt, bill or submit again.
- `cancelIntent("requested" | "acknowledged")` records remote cancellation
  separately from task status. An acknowledgement is not proof of cancellation;
  subsequent successful completion remains possible. Stopping local waiting
  requires no remote-cancellation journal write. `forget` only removes the local
  Session record and does not cancel or delete remote work.

The journal never invokes a model, fulfills a host request, sends an RPC, polls,
retries, attaches Context or grants tool permission. An integrating runtime must
enforce those boundaries and check current authorization/catalog state before
each network or host-service action.

## Limits and recovery

Each Session retains at most 64 records / 512 KiB. Each task permits 32 unique
host-input claims, four sampling reservations and 16,384 reserved output tokens,
at most 4,096 per reservation. The ownership index retains up to 1,024 hashed
remote-id tombstones per endpoint identity. It fails closed when full; explicit
store maintenance requires auditing outstanding handles before removing that
identity's tombstones. Local forgetting does not remove them automatically.

Only routing metadata, timestamps, status and hashed claims are persisted—not
arguments, status messages, input requests, answers, errors or final results.
Remote ids and owner labels are encrypted by the keyring vault. An ownership
reservation precedes the Session update, so a partial write leaves a restrictive
tombstone, never an id another Session can claim. A normal reopen restores the
metadata without network activity. Corrupt data or an unavailable keyring fails
closed; unknown formats are not silently migrated. As with the credential vault,
a crashed process can leave a `.lock` file: verify that its recorded PID has
exited before removing that specific stale lock. Never reset the vault to make
an unknown task outcome look safe to replay.

`parseMcpTask` validates the extension discriminator, flat id, states, timestamps,
TTL/poll hints and bounded status-specific payload shape. It does not validate
final tool schemas or execute input requests; no TTL or polling policy is hidden
inside storage. Evidence: `packages/mcp/test/task-journal.test.mjs` covers in-memory
and encrypted reopen, owner/auth/tool mismatch, cross-Session duplicate ids,
partial writes, input deduplication/budgets, cancellation races, bounds and tamper
rejection. These are storage/parser checks, not remote-server conformance tests.
