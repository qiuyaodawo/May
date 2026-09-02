# Custom Session storage

**English** | [简体中文](../zh-CN/guides/custom-storage.md)

May separates durable conversation history from session discovery:

- `SessionStore` stores the ordered `SessionEvent` stream and is the source of
  truth for resume.
- `SessionCatalog` stores lightweight summaries used to list, rename, select,
  and delete sessions in a workspace.

`AgentApplication` requires a `SessionStore`. `AgentWorkspace` additionally
requires a `SessionCatalog`.

## `SessionStore` contract

```ts
interface SessionStore {
  append(event: SessionEvent): Promise<void>;
  read(sessionId: string): Promise<readonly SessionEvent[]>;
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

## Database adapter skeleton

The following adapter keeps database-specific code behind a small transactional
port. `appendIfCurrentSequence` must check the current maximum sequence and
insert the new row in the same transaction.

```ts
import {
  validateSessionHistory,
  type SessionEvent,
  type SessionStore,
} from "@may/session";

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

The Catalog is an index, not conversation truth. `AgentWorkspace` deliberately
tolerates Catalog-recording failures so an agent run is not lost merely because
the recent-session list could not be updated. Provide a rebuild path from
Session histories if catalog durability matters.

## Built-in local storage

For a local Node.js product, no custom adapter is required:

```ts
import { AgentApplication, AgentWorkspace } from "@may/application";
import { FileSessionCatalog } from "@may/session/catalog";
import { FileSessionStore } from "@may/session/file-store";

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
```

The JSONL Session store is plaintext and assumes one active writer per session
history. The file Catalog uses append-only atomic operation files across local
processes, but does not compact that operation directory automatically. Neither
backend is a multi-host database or encrypted secret store.

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
