---
"@sortedyuan/may": minor
"@sortedyuan/coordination": minor
---

Add durable continuation identities and public Session outcome queries. Attached
coordination agents preserve each continuation identity across cancellation and
restart, and record their recovery protocol with dispatch. Existing dispatched
continuations without identity require a verified recovery finding. Hosts wrapping
coordination adapters must forward their optional recoveryVersion property.

Preserve the complete Model interface through Goal wrappers, including dynamic
capabilities and preflight validation before model-call accounting. Locally rejected
requests keep known usage and produce no physical-attempt record.
