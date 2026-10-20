---
"@sortedyuan/maybecode": minor
---

Coordinate team manifest, status, acceptance, and cancellation file access across processes so concurrent status queries can coexist with team command updates on Windows.

Breaking change: initial access creates empty `.access` and `.access.gate` coordination files and needs directory write permission. Subsequent readers open both files read-only. To migrate existing records, run `team status <id>` once with directory write permission before granting read-only directory access, and retain both coordination files while the records are in use.
