---
"@sortedyuan/eval": minor
---

Coordinate JSON record reads and atomic replacements across processes with short SQLite transactions, preventing Windows sharing violations during live experiment observation.

BREAKING: FileEvalStore readers require write access to record directories for the automatically created record-access.sqlite databases. Stop all readers and writers before upgrading them together, grant directory write access, and retain these databases while the store is in use. Existing JSON records retain their format. Lock acquisition is bounded to five seconds.
