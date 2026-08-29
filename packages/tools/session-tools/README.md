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
