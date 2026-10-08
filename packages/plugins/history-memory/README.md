# @may/plugin-history-memory

`budget` accepts a Context budget or a callback receiving the effective Model.
The callback runs after Model wrappers have been applied, so provider plugins can
determine Context capacity during setup.

`createHistoryMemoryPlugin(options?)` provides `historyMemoryService` and
`services.contextOptions`. It registers capacity inspection and work-note tools,
wraps the Context factory, and attaches memory in `application.created`.
`mode` selects `prune-summary`, `history-reference`, or `provider-native`;
explicit automatic strategies override the selected mode. The options also
accept a budget, summarizer, and manual compaction strategy.

History-reference guidance is registered through `instructionSources` with
`order: 60` when that automatic mode is active. Other modes and explicit automatic
strategy overrides contribute no reset guidance. The Context wrapper manages
capacity warnings and deferred resets. Saved notes appear as `Saved work state`
reference data after a reset.
Custom `PluginHost` compositions must provide `applicationServices.instructionSources`.
`AgentApplication` supplies this registry automatically.

`historyMemoryService` exposes the actual memory instance and manual, summary,
history-reference, and native strategies. Saved notes have versioned plugin
state and retain the `maybecode.context-notes` history record. Resets require
fresh notes covering current input and tool outcomes, preserve the current user
request, and retain durable history for retrieval. Input acceptance and closing
cancel outstanding deferred reset requests. `HistoryReferenceMemory` and
`createModelContextSummarizer` remain available for direct composition.
Direct `memory.wrap(factory)` supplies history-reference guidance by default;
`memory.wrap(factory, { includeInstructions: false })` lets the host register
`memory.instructions()` in its own instruction sources.

Read the [Chinese version](README.zh-CN.md).
