# External Agent RPC adapter

MaybeClaw exports `@may/maybeclaw/rpc`. Configure an Agent with `adapter: "module"`, `module: "@may/maybeclaw/rpc"`, and `options` describing a stdio or socket connection. The module exports `createAdapter`.

```json
{
  "id": "external",
  "adapter": "module",
  "module": "@may/maybeclaw/rpc",
  "options": {
    "transport": "stdio",
    "command": "node",
    "args": ["external-agent.mjs"],
    "cwd": "agent-directory",
    "timeoutMs": 30000,
    "executionTimeoutMs": 0
  }
}
```

Stdio starts the configured executable directly with `shell: false` and hides the process window on Windows. `env` optionally supplies environment variables. The executable must reserve stdout for RPC; diagnostic output belongs on stderr. Closing the adapter terminates the owned child process. Cancelling one conversation sends an RPC request and preserves the shared process.

Socket options are `{ "transport": "socket", "path": "socket-or-Windows-pipe" }` or `{ "transport": "socket", "host": "127.0.0.1", "port": 12345 }`. A socket connection does not own the remote process; closing the adapter closes the connection. Restrict socket access to trusted hosts or use an authenticated protected tunnel. This transport does not add network authentication or encryption.

`timeoutMs` limits connection setup and management requests. `executionTimeoutMs: 0` permits long executions. A timeout or interrupted connection produces `RpcOutcomeUnknownError`, carrying `method`, `requestId`, and `outcome: "unknown"`. Queries reconnect a disconnected transport, repeat the handshake and verify unchanged capabilities before looking up the original request. The adapter never resubmits an uncertain operation automatically.

## Protocol

The connection uses the `vscode-jsonrpc` stream reader and writer, including their standard Content-Length framing. Both peers can send JSON-RPC requests. Do not write an independent framing parser.

The first request is `gateway/initialize` with `{ protocolVersion: 1, agentId }`. Return:

```json
{
  "protocolVersion": 1,
  "capabilities": {
    "cancel": true,
    "steer": false,
    "resume": true,
    "delete": true,
    "approvals": false,
    "collaboration": false,
    "media": []
  },
  "commands": ["status"]
}
```

Only declare implemented capabilities. `commands` lists the Agent commands that Gateway may forward. `new` and `resume` remain conversation-management operations.

`media` accepts `image`, `audio`, `file`, and `video`. Video is an independent capability: its input uses a file content part with the original `video/*` MIME type. Declare support only when the external Agent can process the content.

| Method | Parameters | Result |
| --- | --- | --- |
| `conversation/create` | `requestId` | `{ conversationId }` |
| `conversation/inspectCreation` | `requestId` | `{ status: "not-started" }`, `{ status: "ready", conversationId }`, or `{ status: "unknown" }` |
| `conversation/execute` | `conversationId`, `inputId`, `input`, `tools`, `permissionScope?` | `{ text, runId?, yielded?, content? }` |
| `conversation/inspect` | `conversationId`, `inputId` | `{ status, text?, detail?, content?, runId? }` |
| `conversation/cancel` | `conversationId` | `{ cancelled: true }` after cancellation completes |
| `conversation/steer` | `conversationId`, `inputId`, `text` | `{ status }` |
| `conversation/steeringInputs` | `conversationId` | `[{ inputId, text, status }]` |
| `conversation/resolveApproval` | `conversationId`, `requestId`, `decision`, `options?` | `{ resolved: boolean }` |
| `conversation/release` | `conversationId` | `{ released: true }` |
| `conversation/delete` | `conversationId` | `{ deleted: true }` |
| `conversation/command` | `conversationId`, `name`, `args` | `{ text }` |

`input` is a May `UserMessage`. `tools` contains the names, descriptions and input schemas of the coordination tools authorized for that execution when collaboration is supported. Execution status is `not-started`, `queued`, `running`, `waiting`, `cancelling`, `completed`, `failed`, `cancelled`, or `recovery-required`.

`permissionScope` is an optional trusted initiator identity supplied by the host.
For `allow-persistent`, `options` carries `{ createdBy, expiresAt? }`. The external
Agent validates and stores its own permission rules. The Gateway authorizes
persistent approvals only for its service administrator and when the request
declares a persistent scope with the feature enabled.

Persist creation and execution request IDs. Reusing an ID must refer to the same operation, and changed input under the same ID must fail. Resource release preserves conversation history. Deletion removes the dedicated Agent conversation. Only one execution may run within a conversation.

Declaring `steer: true` requires both steering methods. Persist each input with status `pending` while waiting for a Step boundary, `delivered` after inclusion, `idle` when execution has ended normally before inclusion, or `cancelled` after explicit interruption. Gateway queries this list after execution and across restarts. An `idle` input is executed with the same `inputId`; it must then become `delivered`. `conversation/steeringInputs` reconnects and repeats capability checks just like the other query methods.

## Agent callbacks

Every callback includes `conversationId` and `inputId` identifying an active execution:

- Notification `gateway/event`: `{ conversationId, inputId, event }`, where `event` is a May `AgentApplicationEvent`.
- Request `gateway/shouldYield`: `{ conversationId, inputId }`, returning a boolean. Check at Step boundaries.
- Request `gateway/tool`: `{ conversationId, inputId, name, callId, step, input }`, returning the selected coordination tool result. This is available only when collaboration was declared. The tool must be in the execution's supplied list. Reusing `callId` with changed input fails.
- Gateway sends notification `gateway/toolProgress`: `{ conversationId, inputId, callId, update }` when an executed tool reports progress.

The external Agent owns its model, ordinary tools, tool approval enforcement, context and history. Gateway routes approval responses after checking the user's session permissions.

The workspace applies `patches/vscode-jsonrpc@9.0.2.patch` through pnpm. A transport write failure rejects the original RPC request once. Gateway records the request outcome as unknown and requires a status query; a second rejection from the library's asynchronous Promise executor must not terminate the service. The process-termination case in `test/gateway-membership.test.mjs` verifies this behavior with a real child process.

## Executable example

`examples/rpc-file-agent.mjs` is an independent file-operation service with persistent conversations. It computes SHA-256 for files inside its configured workspace or waits for a file to appear. It supports stdio and socket modes. It performs deterministic file operations and does not call a language model.

Start it with `node examples/rpc-file-agent.mjs --directory <state-directory> --workspace <workspace-directory>`. Add `--socket <path>` to serve multiple socket connections. Execution input text is JSON, for example `{ "operation": "sha256", "path": "README.md" }` or `{ "operation": "waitForFile", "path": "result.txt" }`.

Add `--no-cancel` to disable cancellation for the service. Its handshake reports `cancel: false`, and cancellation requests are rejected while accepted file operations continue. Gateway still revokes a departed member's access and reports any execution it cannot stop.

`test/gateway-rpc.test.mjs` starts this service in actual child processes, verifies file hashes and persisted request state, cancels a running conversation while another conversation continues, and reconnects to a socket service after an execution timeout.
