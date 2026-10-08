---
"@may/goal": minor
"@may/plugin-goals": minor
"@may/plugin-history-memory": minor
---

Compose active Goal and history-reference guidance through ordered instruction
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
