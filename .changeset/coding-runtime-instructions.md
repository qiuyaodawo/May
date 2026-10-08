---
"@may/coding-tools": minor
---

Add `codingRuntimeInstructions` to generate workspace, operating system, shell syntax, session role and origin, and optional permission and assignment information. Shell runtime guidance now contains syntax instructions, and composed project instructions include their source file path.

Preserve shell metadata across `ToolRegistry` snapshots so applications can include the available shell in runtime instructions after tool composition. Model-facing tool definitions retain their existing fields.
