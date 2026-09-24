---
"@may/config": minor
---

Extend the published configuration schema with MaybeClaw Gateway version 2,
registered May and module Agent adapters, explicit image/audio/file/video capabilities, access controls, channel group settings,
an explicit HTTPS origin for reverse-proxy access, and lifecycle limits. Version 2 requires an explicit Agent list and configures
Run budgets per Agent. Existing configurations without a version retain legacy
validation; migrate them with the MaybeClaw migration workflow before enabling
the Gateway.
