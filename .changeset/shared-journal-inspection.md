---
"@sortedyuan/coordination": minor
"@sortedyuan/plugin-delivery": minor
---

Coordinate journal inspection with appends, tail repair and checkpoint replacement across processes, preserving complete snapshots during concurrent reads and writes on Windows.

Breaking change: each journal now keeps permanent `.access` and `.access.gate` files. The first open or inspection requires directory write permission to create them. For existing data, stop the hosts, upgrade all processes sharing the directory, and run an inspection with directory write permission before assigning read-only access to monitors. Keep the access files readable to monitors and preserve them while any reader or writer is active.
