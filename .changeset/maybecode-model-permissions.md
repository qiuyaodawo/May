---
"@may/maybecode": minor
---

Switch models and change reasoning effort through plugin updates within the existing application and Session. Refresh model-dependent services and event subscriptions while preserving conversation history, paused goals, active skills, durable notes, and YOLO approvals. Keep shared MCP resources alive and release application-owned plugin resources during updates.

Expose `MaybeCodeApplication.updateModel()` and `modelUpdateFailed` for hosts that manage model selection. Failed updates stop new input until a successful model-update retry.
