---
"@may/permissions": minor
"@may/application": minor
"@may/session": minor
"@may/ui-client": minor
"@may/tui": minor
"@may/web-ui": minor
"@may/config": minor
"@may/coding-tools": minor
"@may/plugin-agent-adapters": minor
---

Add opt-in persistent allow and deny rules with trusted scope, tool-definition
binding, creator identity, expiry and revocation. Provide a versioned file store
with atomic replacement and a single writer lock through
`@may/permissions/file-store`. Rule storage and event persistence failures stop
tool execution. Explicit denials take precedence, and `requireApproval` requests
always require a fresh decision.

Expose trusted rule management and persistent approval resolution through
Application and Workspace controllers. Persist rule events in Session history
without adding them to model context. Add persistent approval ranges and rule
management controls to terminal and Web UI components, with host-owned creator
identity. Agent adapters accept trusted execution scopes and persistent approval
metadata. Export workspace path checks for host permission policies.

Provide `beforeCheck` for one-time execution preparation from immutable inputs,
and keep Application tool previews separate from repeated permission evaluations.

Add `apps.maybecode.persistentRules` and `apps.maybeclaw.persistentRules` to the
configuration schema. Both default to false. MaybeCode stores project rules in
`.may/permission-rules.json`; MaybeClaw stores them in its data directory and
restricts management to operators.

Compatibility: the public `ApprovalDecision`, `PermissionEvent` and
`SessionEvent` unions gain variants. Exhaustive TypeScript consumers must add
`allow-persistent` and `rule.created` / `rule.revoked` / `rule.used` handling.
Access `requestId` only after narrowing to `approval.resolved` or
`approval.cancelled`, and offer persistent approval only when request metadata
exists. Supply a trusted `createdBy` identity when resolving it. Existing policy
return values and existing Session histories remain supported. Readers of
histories containing rule events must use the updated Session package.
