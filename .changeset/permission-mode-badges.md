---
"@may/ui-client": minor
"@may/web-ui": minor
"@may/config": minor
"@may/tui": minor
---

Expose optional host status badges in UI snapshots and render them in the fixed
Web UI header, including on narrow screens. Add the MaybeCode permissionMode
configuration schema for default approvals and opt-in YOLO auto-approval.
The line-oriented terminal can update an active prompt while preserving its
input and cursor, allowing connected views to keep status indicators current.

MaybeCode supports --yolo, --no-yolo and /yolo [on|off|status], preserves explicit
policy denials, and displays the current mode in terminal and Web UI sessions.
The bare /yolo command enables the mode; /yolo status reports it without changes.
