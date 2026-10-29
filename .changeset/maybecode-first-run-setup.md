---
"@sortedyuan/maybecode": minor
"@sortedyuan/may": minor
"@sortedyuan/tui": minor
---

Add English first-run setup to MaybeCode when its configuration file is missing in an interactive terminal. Guide users through provider, credentials, model settings, optional live connection verification, and saving before continuing into the selected UI. Preserve existing configuration files and report noninteractive setup instructions.

Add password input to `TerminalIO.question` with hidden characters and isolated input history in interactive terminals.

Add `createMayConfig` for validated, coordinated creation of complete configuration files without replacing an existing destination. Publishing requires storage with hard-link support.
