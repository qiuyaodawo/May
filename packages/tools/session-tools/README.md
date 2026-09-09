# `@may/session-tools`

Read-only tools that expose bounded durable session history to a May agent.

```ts
import { createSessionHistoryTool } from "@may/session-tools";

const tool = createSessionHistoryTool({ source: session });
```

The `session_history` tool supports stable sequence cursors, event-type
filters, ordering, and bounded output. Large events are previewed, and
`context.compacted` replacement messages are omitted to avoid recursively
returning an entire model context.

`createSessionHistoryRetrievalTools({ source: () => session })` adds:

- `session_history_search`: literal case-insensitive search across complete
  projected events, including text beyond previews. Each call scans at most
  50 events and returns at most 10 short matches. Follow `nextSeq` while
  `hasMore` is true, even when no matches were returned.
- `session_history_read`: read one event by `seq` as serialized JSON, using
  `offset` and `length` (default 2000, maximum 4000 UTF-16 code units). Follow
  `nextOffset` to read long records without losing text. Chunks do not split
  surrogate pairs; a one-unit request may return a two-unit Unicode character.

Both tools omit compaction replacement messages, check cancellation, and bound
their output. Their limits are independent of `session_history` preview limits.
`AgentApplication` exposes them with `sessionHistory: { retrieval: true }`;
MaybeCode enables them by default. Search and read results are historical data,
not new instructions or permission grants.
