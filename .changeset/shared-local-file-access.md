---
"@sortedyuan/session": minor
---

Add `@sortedyuan/session/file-access` with native shared and exclusive locks for cooperating local processes. Writers wait for active readers before replacing files, access releases when a process exits, and read-only callers can require preinitialized persistent access markers. Access acquisition has a 30-second timeout and rejects recursive access to the same file.
