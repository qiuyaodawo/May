# Configure Session storage

**English** | [简体中文](../../zh-CN/guides/custom-storage.md)

May separates durable conversation history from session discovery:

- `SessionStore` stores the ordered `SessionEvent` stream and is the source of
  truth for resume.
- `SessionCatalog` stores lightweight summaries used to list, rename, select,
  and delete sessions in a workspace.

`AgentApplication` requires a `SessionStore`. `AgentWorkspace` additionally
requires a `SessionCatalog`. Use this guide to select the built-in local
storage or implement a database adapter. It assumes the host has a configured
model and permission policy; see [Build an Agent](building-an-agent.md).

## Select a backend

| Requirement | Backend |
| --- | --- |
| Process-local history | `InMemorySessionStore` from `@sortedyuan/session` |
| Local history across restarts | `FileSessionStore` from `@sortedyuan/session/file-store` |
| Local Session discovery | `FileSessionCatalog` from `@sortedyuan/session/catalog` |
| Database, encryption, or cross-process coordination | Custom implementations of the interfaces below |

For file-backed storage, jump to [Built-in local storage](#built-in-local-storage).
Database adapters must implement durable writes and consistent ordered reads.

## `SessionStore` contract

```ts
interface SessionStore {
  readonly directory?: string;
  append(event: SessionEvent): Promise<void>;
  read(sessionId: string): Promise<readonly SessionEvent[]>;
  inspect?(sessionId: string): Promise<readonly SessionEvent[]>;
  delete?(sessionId: string): Promise<boolean>;
}
```

`read()` must return the complete stream in ascending sequence order. Events
must have the requested session ID and contiguous `seq` values starting at 1.
May validates these conditions before replay.

`append()` must either durably commit one complete event or reject. It must not
acknowledge a buffered write that can be silently lost. Session serializes
writes made through one Session instance, but a shared backend must still make
the next-sequence check atomic across processes.

`inspect()` returns committed history without repair, writer ownership changes or
other writes. Session branching and workspace history/tree browsing require this
operation. A successful branch boundary is recorded as `run.settled`; a fork
stores its exact source in `session.created.fork` and ends initialization with
`session.fork.ready`. An incomplete fork remains inspectable and cannot resume.
Custom adapters must retain these records and reject failed writes.
`run.settled.hostCompleted: true` means the host verified that a scheduler-yielded
Run completed successfully after saving final application state.

## Database adapter skeleton

Create the adapter module in an application that depends on `@sortedyuan/session`.
The `SessionEventTable` below is a database integration interface; supply its
implementation using your database library before instantiating the store.
`appendIfCurrentSequence` must check the current maximum sequence and
insert the new row in the same transaction.

```ts
import {
  validateSessionHistory,
  type SessionEvent,
  type SessionStore,
} from "@sortedyuan/session";

export interface SessionEventTable {
  appendIfCurrentSequence(input: {
    readonly sessionId: string;
    readonly expectedCurrentSequence: number;
    readonly nextSequence: number;
    readonly json: string;
  }): Promise<boolean>;

  readAscending(sessionId: string): Promise<readonly string[]>;
  deleteSession(sessionId: string): Promise<boolean>;
}

export class DatabaseSessionStore implements SessionStore {
  constructor(private readonly table: SessionEventTable) {}

  async append(event: SessionEvent): Promise<void> {
    const committed = await this.table.appendIfCurrentSequence({
      sessionId: event.sessionId,
      expectedCurrentSequence: event.seq - 1,
      nextSequence: event.seq,
      json: JSON.stringify(event),
    });
    if (!committed) {
      throw new Error(
        `Session ${event.sessionId} is no longer at sequence ${event.seq - 1}`,
      );
    }
  }

  async read(sessionId: string): Promise<readonly SessionEvent[]> {
    const rows = await this.table.readAscending(sessionId);
    const events = rows.map((row, index) => decodeEvent(row, index + 1));
    validateSessionHistory(sessionId, events);
    return events;
  }

  delete(sessionId: string): Promise<boolean> {
    return this.table.deleteSession(sessionId);
  }

  inspect(sessionId: string): Promise<readonly SessionEvent[]> {
    return this.read(sessionId);
  }
}

function decodeEvent(source: string, row: number): SessionEvent {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`Invalid session event JSON in row ${row}`);
  }
  if (
    typeof value !== "object" || value === null ||
    !("type" in value) || typeof value.type !== "string" ||
    !("sessionId" in value) || typeof value.sessionId !== "string" ||
    !("seq" in value) || typeof value.seq !== "number" ||
    !Number.isSafeInteger(value.seq) ||
    !("timestamp" in value) || typeof value.timestamp !== "number"
  ) {
    throw new Error(`Invalid session event in row ${row}`);
  }
  return value as SessionEvent;
}
```

Use a uniqueness constraint on `(session_id, seq)`, and lock or compare the
session's current sequence inside the insertion transaction. A uniqueness
constraint alone detects duplicate sequence numbers but does not prevent two
writers from creating gaps through incorrect retry logic.

The decoder above checks the common event envelope, matching the built-in file
store's baseline. A backend that accepts data from outside the trusted May
process should additionally validate every discriminated event payload and
apply size limits before casting it to `SessionEvent`.

## `SessionCatalog` contract

```ts
interface SessionCatalog {
  list(workspace: string): Promise<readonly SessionSummary[]>;
  record(summary: SessionSummary): Promise<void>;
  rename?(sessionId: string, workspace: string, title: string): Promise<boolean>;
  remove?(sessionId: string, workspace: string): Promise<boolean>;
}
```

Catalog implementations should upsert summaries without replacing an existing
`createdAt`, isolate records by normalized workspace, and normally return most
recently used sessions first. `rename` and `remove` are optional; the workspace
controller reports those operations as unsupported when they are absent.

The Catalog provides an index; Session history stores conversation facts.
`AgentWorkspace` tolerates ordinary Run-summary recording failures and retains
the Run result. Provide a rebuild path from Session histories if catalog
durability matters.

## Built-in local storage

Add `@sortedyuan/application` and `@sortedyuan/session` as direct application dependencies.
In the entry point, initialize `model`, `tools`, and `permissionPolicy` before
this composition snippet. Paths are relative to the process working directory:

```ts
import { AgentApplication, AgentWorkspace } from "@sortedyuan/application";
import { FileSessionCatalog } from "@sortedyuan/session/catalog";
import { FileSessionStore } from "@sortedyuan/session/file-store";

const store = new FileSessionStore(".may/sessions");
const catalog = new FileSessionCatalog(".may/catalog.json");

const workspace = await AgentWorkspace.open({
  workspace: process.cwd(),
  store,
  catalog,
  openApplication: ({ sessionId, resume }) => AgentApplication.open({
    model,
    tools,
    permissionPolicy,
    store,
    resume,
    ...(sessionId === undefined ? {} : { sessionId }),
  }),
});

try {
  const run = await workspace.submit({ input: "Inspect the current state" });
  await run.result;
} finally {
  await workspace.close();
}
```

The JSONL Session store is plaintext and assumes one active writer per session
history. The file Catalog uses append-only atomic operation files across local
processes, but does not compact that operation directory automatically. Neither
backend is a multi-host database or encrypted secret store.
After stopping other Catalog users, call `compact({ confirmHostsStopped: true })`;
see [Local storage maintenance](#local-storage-maintenance) for the complete procedure.

## Coordinate local file access

For an application-owned local file shared by several processes, use
`withFileAccess` from `@sortedyuan/session/file-access`. Add `@sortedyuan/session`
as a direct dependency, save this example as `shared-state.mjs`, and run
`node shared-state.mjs` from the application directory. It writes one complete
JSON value and prints `1` after reading it through the same access helper.

```js
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withFileAccess } from "@sortedyuan/session/file-access";

await mkdir(".may", { recursive: true });
const path = resolve(".may/shared-state.json");
await withFileAccess(path, "exclusive", async () => {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ revision: 1 }));
  await rename(temporary, path);
});
const state = await withFileAccess(
  path,
  "shared",
  async () => JSON.parse(await readFile(path, "utf8")),
  { initialize: false },
);
console.log(state.revision);
```

Use `"shared"` for reading and `"exclusive"` for the whole write, replacement, or
deletion operation. Every process must use the helper with the same path. Await
all file operations and close handles inside the callback. The returned promise
preserves its result or error. Access is released when the callback settles or
the owning process exits. The helper coordinates local files using
`fs-native-extensions`; multi-host storage needs its own coordination backend.

The first call creates empty `<path>.access` and `<path>.access.gate` files with
mode `0600`. Keep both files while the store is in use; removing or replacing
them requires all users to stop. A writer holds the gate while existing readers
finish, so incoming reads wait. Access acquisition checks every 10 ms and rejects
with `ETIMEDOUT` after 30 seconds. The callback itself has no time limit.

For a read-only process, initialize both markers once with directory write
permission, then pass `{ initialize: false }`. This option creates no markers and
reports `FILE_ACCESS_NOT_INITIALIZED` if either marker is absent. Shared access
requires only read permission on existing markers; exclusive access requires
write permission. Symbolic links, non-regular markers and changed marker identity
are rejected. Calling the helper recursively for the same file from its callback
rejects immediately with `FILE_ACCESS_REENTRANT`.

The example retains the JSON value and both markers for reuse. After every
participating process has stopped, remove the value and both markers when deleting
the store. Session history still requires its storage host to own the lifetime
of its single active writer.

## Verify persistence

Save the active `workspace.sessionId`, close the workspace, and reopen it with
that `sessionId` and the same storage paths. Confirm that `history()` returns
the submitted input and completed response. For a database backend, also verify
that a stale sequence append rejects and leaves committed history unchanged.
Use `inspect()` to confirm browsing performs no writes.

## Failure and lifecycle rules

- Propagate storage errors; never turn them into an empty history.
- Do not edit or renumber committed events in place.
- Make append retries idempotent or detect the already-committed exact event.
- Bound event and history sizes before accepting untrusted records.
- Treat Session metadata, model messages, tool output, approvals, and tool
  presentations as potentially sensitive.
- Implement retention, backup, encryption, and access control in the backend or
  its deployment; May does not add them automatically.
- Close database pools after `AgentApplication.close()` or
  `AgentWorkspace.close()` has completed.

History deletion and Catalog removal are separate calls and are not a
cross-store transaction. Design reconciliation for partial failure when using
different systems for the two interfaces.

See [Custom Context](./custom-context.md) for the distinction between a
model-visible working set and durable history, and
[Runtime and session boundaries](../architecture/runtime-session.md) for the
full lifecycle.

## Local storage maintenance

`FileSessionStore` serializes reads, writes and tail repair per Session in one instance.
Append validation reuses the last sequence only while file identity, length and timestamps
match; explicit history reads still validate complete records. Keep one writer per file.
`input.generated` records preserve Hook continuation and inherited delivered steering
messages. Reads and read-only inspection validate their Run identity, positive step,
user-message content and reason before Session replay.
New session files sync their parent directory on POSIX; Node does not offer equivalent
Windows directory fsync.

To collapse catalog operation files, stop all other catalog users and call
`await catalog.compact({ confirmHostsStopped: true })` on `FileSessionCatalog`.
The atomic version-2 catalog snapshot records exact absorbed operation names before cleanup,
so interruption during deletion cannot replay already absorbed operations. Do not use older
readers after compacting; ordinary version-1 catalogs remain readable.

For local writer locks, import `recoverFileLock` from `@sortedyuan/session/file-store`. Stop all
competing hosts/open/recovery operations, read and inspect the lock, then pass its exact
text as `expectedContents` with `confirmHostsStopped: true`. The helper rejects live PIDs,
remote-host ownership, unsafe links and changed metadata. Incomplete metadata additionally
requires `confirmUnknownOwner: true` after independent owner verification. PID probing is
not atomic lock election; recovery must never race another acquirer. Recovery only releases
ownership and never replays work.
