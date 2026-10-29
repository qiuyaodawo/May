# @sortedyuan/may

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
- c23ff33: Add durable continuation identities and public Session outcome queries. Attached
  coordination agents preserve each continuation identity across cancellation and
  restart, and record their recovery protocol with dispatch. Existing dispatched
  continuations without identity require a verified recovery finding. Hosts wrapping
  coordination adapters must forward their optional recoveryVersion property.

  Preserve the complete Model interface through Goal wrappers, including dynamic
  capabilities and preflight validation before model-call accounting. Locally rejected
  requests keep known usage and produce no physical-attempt record.
- 1dd118f: Add English first-run setup to MaybeCode when its configuration file is missing in an interactive terminal. Guide users through provider, credentials, model settings, optional live connection verification, and saving before continuing into the selected UI. Preserve existing configuration files and report noninteractive setup instructions.

  Add password input to `TerminalIO.question` with hidden characters and isolated input history in interactive terminals.

  Add `createMayConfig` for validated, coordinated creation of complete configuration files without replacing an existing destination. Publishing requires storage with hard-link support.
- c23ff33: Provide shared local file access, writer ownership and durable replacement through
  the `@sortedyuan/may/storage` entry. Configuration, media, MCP and
  delivery reuse this storage module. Session's file
  subpaths reexport the same functions and retain shared lock state and behavior.
- c23ff33: Add shared Session transcript reading for user input, recovery findings, and delivered steering. Web history, search, full-field reads, and retained TUI history preserve these messages and execution outcomes consistently.

  Breaking: TUI tool items now include denied, not-started, and unknown statuses, and assistant items include interrupted. Update exhaustive custom renderers to handle these states.

  Validate ApplicationUiHost commands directly from current execution and ownership state. Presentation reads leave commands available, and host shutdown settles accepted work while rejecting later commands.
- c23ff33: Expose structural contribution registries and separate Application execution,
  history and state service interfaces. Application service views preserve identity
  through plugin replacement and reject access before creation or after closure.

  **Breaking:** `ApplicationAccess.get()` and `GoalsPluginOptions.createAgent` now
  expose `ApplicationFacade`. Type plugin integrations against the required service
  interfaces. Application closing, plugin updates and skill activation belong to
  the host. `services.toolSources.snapshot()` returns `Iterable<Tool>`; consumers
  that need catalog methods can construct a `ToolRegistry` from that iterable.

### Patch Changes

- 437b090: Reject pending Session continuations after runtime closure. Preserve active
  conversation ownership when concurrent adapter calls target the same Session.
  Attached coordination runs enforce both coordinator and host budgets and recover
  later turns using the host's stable initial input identity.
