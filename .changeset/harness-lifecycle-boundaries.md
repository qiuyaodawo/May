---
"@sortedyuan/may": patch
"@sortedyuan/coordination": patch
"@sortedyuan/gateway": patch
---

Reject pending Session continuations after runtime closure. Preserve active
conversation ownership when concurrent adapter calls target the same Session.
Attached coordination runs enforce both coordinator and host budgets and recover
later turns using the host's stable initial input identity.
