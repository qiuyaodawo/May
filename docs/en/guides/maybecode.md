# Use MaybeCode

**English** | [简体中文](../../zh-CN/guides/maybecode.md)

Use MaybeCode to work with a coding Agent in a terminal or browser. Prepare the
repository with [the development guide](repository-development.md). First-run setup
creates a provider and model profile; additional settings are described in
[the configuration reference](../reference/configuration.md).
The application uses the selected model's API and operates in its starting directory.

Applications that provide custom tools through `MaybeCodeApplicationOptions.tools`
register those tools in the application catalog. Runtime instructions use the same
catalog to describe the current environment.

## Start the application

MaybeCode requires Node.js 22 or newer.

From the May repository root, run:

```bash
pnpm maybecode
```

This package script builds before starting. For a browser interface, follow the
[Web UI procedure](web-ui.md#start-a-standalone-maybecode-web-host) to generate
`MAYBECODE_CONTROL_TOKEN` and start `pnpm maybecode --ui web`.
Check the displayed workspace and model before submitting a task.

## First-run setup

When `~/.may/config.json` is missing, an interactive terminal opens an English
setup wizard. Both standard input and standard output must be terminals.
`--config <path>` asks for confirmation before creating that file. Existing
files with read, JSON, or validation errors report the error and stop.

1. Confirm the displayed configuration path.
2. Select a provider, or choose **Custom compatible service** and its API protocol.
   Enter the base URL; the prompt explains which request path the adapter appends.
3. Select an environment variable available in the current process, or enter an
   API key through the hidden input. Direct API keys are stored as plain text in
   the configuration; environment-variable references store only the variable name.
4. Enter the model ID and profile name. With `--model`, use that profile name.
   Advanced settings accept token limits and the listed adapter options as JSON.
   Enter keeps a displayed value; `:clear` removes an advanced setting.
5. Run the optional connection check. It sends **Reply with OK.** using the actual
   adapter, has a 30-second timeout, and may incur API charges. It contains no
   workspace files or conversation history. Failures retain your input for editing
   and retrying. Skipping displays **Connection: Not verified**.
6. Review the settings and select **Save and start**. The configuration becomes
   available as one complete file, then normal startup reads it and opens the
   selected interface. The new profile becomes `defaultModel`.

Use **Back** or enter `:back` to return; `Ctrl+C` cancels setup with exit code 130.
Menus use Up/Down and Enter; Esc cancels setup. Password input displays no
characters and is excluded from input history.
Input stays in memory until saving. Cancellation leaves the configuration absent.
Saving creates parent directories and coordinates with other configuration users.
If another process creates the file first, setup stops without replacing it.
Storage must support hard links for publishing the complete file. A later
application startup error preserves the saved configuration.

The same terminal wizard serves retained, classic, and Web modes. Web mode checks
`MAYBECODE_CONTROL_TOKEN` before setup. Workspace, resume, permission, and port
arguments continue into normal startup. Noninteractive startup with missing
configuration exits with instructions and code 1. Help, MCP, and team commands
keep their own startup behavior.

The CLI loads the selected command and UI implementation on demand. Image codecs
load when an image needs processing; `/web` loads the Web server and browser
assets when opened. Startup opens the Session and discovers the repository.
Git initialization and checkpoint preparation occur immediately before the first
approved tool that may modify workspace files. Read-only requests create no checkpoint.
A workspace without a Git version displays “Git 尚未准备”.

Each launch creates a new Session by default. On normal exit, MaybeCode deletes
Sessions created during that launch that have no submitted messages, queued
messages, or Runs. These Sessions no longer appear in `/resume` after restarting.
Unsubmitted editor drafts do not retain a Session. Resumed Sessions and Sessions
created through `/fork` are preserved.

Git management is enabled by default. It can initialize a project repository and
create checkpoints. Configure `apps.maybecode.git` and any required commit approval
before working in a project; see [Git configuration](../reference/configuration.md#maybecode-project-git-management).

## Run the local MaybeCode build from PowerShell

To use the local build in another project's directory, add this line to
`$PROFILE.CurrentUserAllHosts`, replacing the checkout path. PowerShell 7 and
Windows PowerShell have separate profiles.

```powershell
. 'E:\code\May\scripts\maybecode-powershell.ps1'
```

Open a new terminal or run `. $PROFILE.CurrentUserAllHosts`. Build the checkout,
then enter the project:

```powershell
pnpm --dir E:\code\May build
Set-Location E:\code\your-project
pnpm maybecode
```

The function starts `apps/maybecode/dist/bin.js`, preserves the working directory,
and forwards options such as `--continue`, `--config`, and `--ui web`. Restart after
rebuilding. A missing entry reports the required build command. Other pnpm commands
use `pnpm.cmd`; `pnpm run maybecode` in the checkout uses the package script.
Terminals started with `-NoProfile` must load the script explicitly.

An installed package supplies the standalone `maybecode` command. To remove an
existing global development installation, use `pnpm remove --global @sortedyuan/maybecode`.

## Control tool approval

Default mode requests approval before commands or file changes. `--yolo` enables
automatic tool approval; `--no-yolo` overrides a configured YOLO default.
Pause or cancel active work before changing mode with `/yolo on` or `/yolo off`.
`/yolo` also enables it, and `/yolo status` reports the state.

The terminal and Web UI display **YOLO · Auto-approve** while enabled. Web UI also
provides a **Permissions** selector. Explicit policy denials remain effective.
See [permission mode](../reference/configuration.md#maybecode-permission-mode) for
scope, restart behavior, persistent rules, and independent team authorization.

## Send input during MaybeCode execution

Ordinary input cancels the current operation, waits for cancellation, and starts
the new request in the same Session. `/steer <message>` waits for the current Step,
including tools and approvals, before delivering additional input. Messages are
saved and delivered in received order. Idle steering starts a Run; input remaining
after completion or a host yield starts after the active operation finishes.

`/stop` and the Web cancel control cancel active work and queued input. `Ctrl+C`
without a text selection does the same in a terminal. Cancelled steering remains
in history and requires a new submission to execute. Classic TUI, retained TUI,
and Web UI provide these controls.

## Browse MaybeCode conversations

The default retained TUI supports mouse-wheel scrolling in terminals with xterm
mouse reporting. Each event scrolls three rows and preserves the draft and focus.
Scrolling up preserves the reading position; returning to the bottom follows new output.

`Ctrl+J` inserts a newline in the retained input editor; `Enter` submits the input.
Up/Down in the input editor selects input history. Press Tab to focus the conversation,
then use Up/Down, PageUp/PageDown, Home, or End to browse.

Press `Ctrl+G`, then `R` to show the beginning of the current turn's completed final
reply. The draft and focus remain unchanged, and the reading position stays until
manual scrolling. This works for restored Sessions and long replies. Before a final
reply completes, the status displays **No final reply yet**.

Drag to select text. `Ctrl+C` copies a selection; without a selection it interrupts
work or exits an idle interface. The input editor supports `Ctrl+A`, `Ctrl+X`, and
`Ctrl+V`, and Shift+arrows or Shift+Home/End extend selection. Home/End move to logical
line boundaries. Typing or pasting replaces selected text. Dragging at a viewport
edge scrolls while selecting. Copies preserve indentation and line breaks.

`Ctrl+G D` toggles tool details; `Ctrl+G T` toggles reasoning. The leader sequence
waits without a deadline and preserves reading position. Escape, focus changes,
mouse navigation, or a dialog ends the sequence. `MAY_TUI_LEADER` sets one modified
leader key; avoid conflicts with editor and terminal shortcuts.

`MAY_CLIPBOARD` accepts `auto` (local system clipboard), `system`, `osc52`, or
`disabled`. Over SSH, select `osc52`, allow terminal clipboard writes, and use
terminal paste. OSC 52 cannot confirm terminal acceptance.

## Find advanced tasks

- [Inspect instructions](maybecode-instructions.md) with `/instructions`.
- [Fork a Session or inspect changes](git-workspaces.md).
- [Resolve interrupted tool outcomes](recovery.md).
- [Configure subagents](subagent-delegation.md) or [run a team](maybecode-team.md).
- [Choose Context behavior](../concepts/context-and-history.md) and
  [set Run budgets](run-budgets.md).
