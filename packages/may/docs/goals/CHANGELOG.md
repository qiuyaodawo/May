# @sortedyuan/goal

## 0.2.0

### Minor Changes

- 8df2b63: Allow Goal Run handles to finalize host resources after verification and durable goal-state updates. Finalization receives completed, continued, failed or cancelled outcomes and finishes before another Run begins, enabling final file checkpoints and workspace leases that remain active during verification.

  Allow delegated model calls to share Goal token accounting, budgets and cancellation while retaining their own task instructions. Apply this wrapper to both default and role-specific child models, so delegated work can execute within an active Goal.

  Expose the updated controller through goalsService. Goal cancellation and budget exhaustion cancel the current execution handle, including delegated tools and executions whose handles arrive after cancellation, and await host finalization before finishing.
- 2a44905: Add independently composed durable goal execution, continuation with optional budgets, model tools,
  usage accounting and recovery. Expose general AgentApplication.continue() without
  adding a dependency on goal execution to base Agent packages.

  MaybeCode integrates /goal start, status, pause, resume and cancel in its terminal
  and Web interfaces, retaining the existing permission policy and session storage.

  Run count and active execution time have no default limits. Explicit budgets remain
  enforced and previously saved budgets retain their values. Breaking SDK type change:
  GoalState.budget.maxRuns and maxDurationMs are optional; SDK consumers must handle
  undefined values as unlimited budgets.
- c8c14c7: Compose active Goal and history-reference guidance through ordered instruction
  sources, with concise execution and context-continuity instructions. Goal guidance
  uses order 40 and history-reference guidance uses order 60. Context wrappers retain
  measurement, request-end Goal reminders, capacity warnings and deferred resets.

  Add optional includeInstructions controls to GoalController.wrapContextFactory
  and HistoryReferenceMemory.wrap for hosts that own instruction composition.
  Direct composition keeps its default guidance. Expose history-reference guidance
  through HistoryReferenceMemory.instructions and label reset notes as Saved work
  state while retaining compatibility with persisted history-reference messages.

  Breaking change: custom PluginHost compositions for the goals and history-memory
  plugins must provide applicationServices.instructionSources. AgentApplication
  already supplies this registry. Add an InstructionSources registry service to
  custom hosts before loading these plugins.
- 63f68e5: Breaking change: package names use the `@sortedyuan` npm scope. Update dependency
  names, imports, pnpm filters, and configured module specifiers from `@may/` to
  `@sortedyuan/`, then reinstall dependencies. MaybeCode provides the `maybecode`
  command and its headless API through `@sortedyuan/maybecode`.

  Plugin IDs, saved Session data, configuration locations, and the Anthropic message
  state format retain their existing identities. OpenTelemetry instrumentation
  uses `@sortedyuan/observability`; update filters that select instrumentation by name.

  The TUI package includes the PNG declarations required by its image dependency,
  so consumers can type-check installed declarations with `skipLibCheck: false`.

### Patch Changes

- 02789c6: Add durable FIFO steering input at complete Step boundaries. AgentApplication and
  Session expose steering status and explicit follow-up execution without
  interrupting current tools or approvals. Preserve delivery identities through
  restart, retain cancelled inputs for explicit resubmission, and keep host yield
  and Run budgets in effect. Add explicit cancellation of pending and idle inputs
  so hosts can stop queued work together with the current execution.

  Session and AgentApplication reserve Step input for their durable steering queue.
  Their submission and continuation options reject custom stepInputSource values
  before execution. Use steer() for durable input; direct May execution retains
  the custom-source API.
  Keep GoalAgent compatible with Session-backed applications by excluding custom
  Step sources from the options passed by the goal scheduler.
- 422e404: Add trusted Tool.workspaceEffect metadata, an approved-tool execution check, deferred
  Git workspace initialization, and lightweight repository summaries. Delegated Agents
  can share the host's execution check. Built-in file readers and session coordination
  tools declare that they preserve workspace files.

  MaybeCode prepares checkpoints immediately before the first approved modifying tool
  in each request, sharing preparation across main and delegated Agents and retaining
  the lease through Goal verification. Startup and read-only requests leave Git state
  unchanged. Each modifying request saves existing user edits before accepting tool writes.
- Updated dependencies [1e9bdfc]
- Updated dependencies [02789c6]
- Updated dependencies [422e404]
- Updated dependencies [88e7d69]
- Updated dependencies [88e7d69]
- Updated dependencies [0dc3f68]
- Updated dependencies [78bde1d]
- Updated dependencies [89bcd8d]
- Updated dependencies [63f68e5]
- Updated dependencies [88e7d69]
  - @sortedyuan/context@0.2.0
  - @sortedyuan/core@0.2.0
