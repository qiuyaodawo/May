---
"@sortedyuan/observability": patch
---

Wait for active OTLP HTTP exports and their diagnostic updates during forceFlush, within the lifecycle timeout.

Count unfinished exports as failed at the lifecycle deadline and prevent delayed callbacks from counting the same failure twice.
