# Session, run, and step

**English** | [简体中文](../zh-CN/concepts/session-run-step.md)

May's execution vocabulary has four levels:

```text
Agent definition -> Session -> Run -> Step
```

The Agent definition is reusable configuration rather than a current runtime
object. `AgentApplication` and `AgentWorkspace` orchestrate the other levels;
see [Agent definition, application, and workspace](./agent-application.md).
For the package ownership view, see
[Runtime and session boundaries](../architecture/runtime-session.md).

## Session

A **Session** is a long-lived conversation identity. It has a stable id,
optional creation metadata, a monotonically sequenced event history, and a
configured `May` runtime. It can outlive any individual Run and can be resumed
with a newly constructed runtime.

`Session.create()` requires a runtime and uses an in-memory store unless a
`SessionStore` is supplied. It refuses to create over a non-empty history and
first appends `session.created`. `Session.resume()` requires an existing,
valid history whose first event is the sole `session.created` event. It replays
model-visible messages, asks the caller to recreate the runtime, and continues
Session sequence numbers after the last stored event.

Session metadata is creation metadata, not mutable Agent configuration. Resume
returns that metadata, but the caller remains responsible for supplying the
current model, tools, instructions, permissions, and Context implementation.

### Submission serialization

`Session.submit()` queues behind the previous Run. Its promise resolves when
the new Run has started, not when the Run has completed. A rejected or failed
Run does not poison the queue for later submissions.

For a normal submission, Session makes `input.submitted` durable before Core
appends the user message to Context. If cancellation arrives during that store
write, Session starts Core first and then forwards cancellation, keeping
durable replay and live Context on the same side of the input commit. An input
whose signal was already aborted before submission is not recorded.

`Session.continue()` starts from existing Context without adding an input
event. `AgentApplication.retry()` uses this only after verifying that the
latest durable Run failed.

## Run

A **Run** is one execution of the Agent loop. `May.run()` begins with a user
message; `May.continue()` begins from existing Context. Both return a handle:

```ts
interface RunHandle {
  readonly id: string;
  readonly events: AsyncIterable<MayEvent>;
  readonly result: Promise<RunResult>;
  cancel(reason?: string): void;
}
```

The Run ends when one of the following occurs:

- the model returns a final assistant message with no tool calls;
- the maximum step count is exceeded;
- model, Context, scheduler, persistence, or fatal tool execution fails; or
- its abort signal or `cancel()` cancels it.

`RunResult` reports the run id, completed step count, model-call count,
tool-call count, final assistant message, and aggregate provider usage when
available. A failed or cancelled Run rejects `result`; consumers should still
consume or relay its events if they require the terminal observation.

Core's default is to reject overlapping Runs because one `May` instance owns a
mutable Context. `Session` additionally queues submissions. The higher-level
`AgentApplication` rejects a second active application operation instead of
queueing it.

## Step

A **Step** is one model request followed by execution of every tool call in the
returned assistant message.

```text
step.started
  -> Context snapshot / optional automatic compaction
  -> model.started
  -> zero or more model deltas or retry notices
  -> model.completed (complete assistant message)
  -> zero or more tool executions
  -> step.completed
```

If the assistant message has no tool calls, the same Step completes the Run.
If it has tool calls, their result messages are appended to Context and the Run
continues with another Step. One Step can therefore contain multiple tool
calls; `maxSteps` limits model/tool iterations, not the number of tools.

The default tool scheduler is sequential, but Core exposes a replaceable
`ToolScheduler`. Regardless of scheduling policy, returned outcomes must match
the original tool-call order. Ordinary tool failures become error tool
messages that the model can observe on the next Step. A fatal tool failure ends
the Run after outcomes have been recorded.

## Cancellation and incomplete tool calls

Cancellation is cooperative through `AbortSignal`. When cancellation happens
during tool work, Core waits for already started tool operations to settle,
creates cancellation results for calls without outcomes, appends a complete
set of tool messages to Context, and emits the available tool outcomes before
`run.cancelled`. This prevents an assistant tool call from being left without a
corresponding tool result in the working conversation.

On resume, Session also detects durable assistant tool calls that have no
stored outcome when a Run was cancelled and reconstructs cancellation tool
messages. This is replay repair for model-visible consistency; it does not turn
transient progress into durable history.

## Identity and ordering

There are two independent sequence domains:

- each `MayEvent` has a Run-local `runId` and `seq`, beginning at one; and
- each `SessionEvent` has a Session-local `sessionId` and contiguous `seq`,
  also beginning at one.

A Step number is local to its Run. Tool operations also carry the Run id, Step,
tool-call id, and an idempotency key through `ToolExecutionContext`.

Do not infer durable continuity from the live Run sequence alone. Streaming
events may be discarded under backpressure, while Session sequence is validated
as contiguous when history is read. See [Events and durability](./events.md).

## What is and is not durable

Session stores submitted messages, completed assistant messages, tool
outcomes, approvals, compaction checkpoints, application tool presentations,
and Run boundaries. It does not store Step start/completion, model start,
streaming deltas, model retry notices, tool start, or tool progress.

Consequently, Session history can rebuild a valid model conversation, but it
is not a byte-for-byte execution trace. The relation between that durable log
and the current Context is covered in
[Context and durable history](./context-and-history.md).

## Current limits

A Session currently has one serialized Run stream and assumes one active
writer to a given history. Session forking, simultaneous cross-process writers,
and distributed execution coordination are not implemented.
