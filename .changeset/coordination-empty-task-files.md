---
"@sortedyuan/coordination": patch
---

`delegate_tasks` and `validateTaskFiles` accept an empty `files` list, which matches the tool schema. A child with an empty list can read workspace files but cannot modify any file; omitting `files` still leaves writes unrestricted.
