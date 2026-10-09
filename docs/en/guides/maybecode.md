# Use MaybeCode

**English** | [简体中文](../../zh-CN/guides/maybecode.md)

Use MaybeCode to work with a coding Agent in a terminal or browser. Prepare the
repository with [the development guide](repository-development.md), and configure
a provider and model profile using [the configuration reference](../reference/configuration.md).
The application uses the selected model's API and operates in its starting directory.

## Start the application

From the May repository root, run:

```bash
pnpm maybecode
```

This package script builds before starting. For a browser interface, follow the
[Web UI procedure](web-ui.md#start-a-standalone-maybecode-web-host) to generate
`MAYBECODE_CONTROL_TOKEN` and start `pnpm maybecode --ui web`.
Check the displayed workspace and model before submitting a task.

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
existing global development installation, use `pnpm remove --global @may/maybecode`.

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
