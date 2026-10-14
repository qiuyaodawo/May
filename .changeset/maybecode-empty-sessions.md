---
"@may/maybecode": patch
---

Delete unused Sessions created during the current MaybeCode launch on normal exit so they no longer appear in `/resume`. Preserve Sessions with submitted or queued messages or Runs, resumed Sessions, and historical forks.
