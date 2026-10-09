---
"@may/coding-tools": minor
---

Discover project instructions from the nearest project root through the startup workspace. Each directory selects a non-empty `AGENTS.override.md`, configured project filename, or fallback filename in that order. Preserve parent-to-child ordering and source paths while keeping the tool workspace unchanged.

Expose the complete ordered `projects` list and `formatCodingProjectInstructions`; retain `project` as the nearest individual document. Add configurable project root markers and fallback filenames, and enforce a combined project-document size limit.
