---
"@may/plugin": minor
"@may/core": minor
"@may/session": minor
"@may/application": minor
"@may/context": minor
"@may/permissions": minor
"@may/config": minor
---

Add scoped plugin composition with typed versioned services, validated dependencies,
configuration and state schemas, lifecycle Hooks, state migration, resource cleanup
and serialized replacement. Agent definitions and applications accept plugins;
MaybeCode and MaybeClaw can load plugin definitions from configuration.

Expose replaceable AgentRuntime factories and runtime state persistence through
Session. The default May runtime retains the existing direct API and integrates
ordered Hooks around input, runs, steps, Context, models, tools, approvals and
recovery. Durable records retain raw tool output and generated continuation inputs.

Runtime identity and state versions are recorded in new Sessions. Existing May
histories remain readable; resuming with an incompatible custom runtime requires
an explicit migration. Plugin replacement waits for active operations, and failed
replacement initialization prevents further execution until composition is repaired.

Breaking change: validated tool argument objects and permission input snapshots
are recursively frozen. Tools and policies must treat arguments as read-only.
Mutable built-in containers such as Date, Map and Set are rejected at the tool
argument boundary; use ordinary data objects and arrays to represent those values.
Custom parsed instances retain their prototypes and methods and must protect any
mutable internal state themselves.
