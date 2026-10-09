---
"@may/web-ui": patch
---

Show the message composer send action while a host with explicit UI controls is
idle, and show cancellation during an active operation only when the host
advertises its configured cancel command. Keep MaybeCode Run and interaction
activity and MaybeClaw queued, running, waiting, and cancelling tasks reflected
in their host controls so connected pages update the composer consistently.

Check slash commands and ordinary messages against their respective host
commands. Keep supported input available during active execution alongside the
cancel action, including run control commands and replacement messages.
