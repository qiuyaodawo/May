---
"@may/coordination": minor
---

Export `coordinationInput` and `createCoordinationTools` so hosts can compose the existing delegation, messaging, and handoff workflow with their own persistent Agent conversations. Export `validateCoordinationSnapshot` for validating durable state before host-specific recovery decisions. Recovery now recognizes cancelled permission requests as evidence that the corresponding tool did not start.
