# @sortedyuan/gateway

## 0.1.0

### Minor Changes

- 437b090: Consolidate the framework into `@sortedyuan/may`, including Core, Application,
  Session, Context, permissions, configuration, storage, Skills, plugin hosting,
  services, goals and history memory. Provider implementations use subpaths of
  `@sortedyuan/providers`. Gateway adapters, RPC, delivery and HTTP services use
  `@sortedyuan/gateway`. Capability plugins use their owning package's public
  subpaths; TUI includes keybindings. Update all consumers to use the same framework
  module identities and runtime dependency chain.

  **Breaking:** Replace component dependencies and imports using
  `docs/en/guides/package-subpaths.md` or `docs/zh-CN/guides/package-subpaths.md`.
  Install `@sortedyuan/may` for framework imports such as
  `@sortedyuan/may/session/file-store`; install `@sortedyuan/providers` for protocol
  imports such as `@sortedyuan/providers/deepseek`. Rebuild applications and third-party
  plugins together. Preserve plugin IDs, service IDs, configuration data and saved
  Session state. MaybeCode carries the consolidated dependencies in its published
  installation; its command names remain unchanged.
- c23ff33: Allow independently implemented channel names and attachment source fields. ChannelAdapter.name accepts a string, and ChannelAttachmentSource contains a platform string plus bounded string fields validated by the owning adapter. ChannelStore provides generic journal persistence while hosts own application migration checks.

  Breaking change: ChannelAttachment.source no longer guarantees Telegram or Feishu fileId/messageId fields. Update attachment readers to validate and read the reference fields required by their own platform. Existing persisted Telegram and Feishu source objects remain readable.

### Patch Changes

- 437b090: Reject pending Session continuations after runtime closure. Preserve active
  conversation ownership when concurrent adapter calls target the same Session.
  Attached coordination runs enforce both coordinator and host budgets and recover
  later turns using the host's stable initial input identity.
- c23ff33: Provide shared local file access, writer ownership and durable replacement through
  the `@sortedyuan/may/storage` entry. Configuration, media, MCP and
  delivery reuse this storage module. Session's file
  subpaths reexport the same functions and retain shared lock state and behavior.
- Updated dependencies [437b090]
- Updated dependencies [c23ff33]
- Updated dependencies [437b090]
- Updated dependencies [1dd118f]
- Updated dependencies [c23ff33]
- Updated dependencies [c23ff33]
- Updated dependencies [c23ff33]
  - @sortedyuan/may@0.1.0
  - @sortedyuan/media@0.4.0
