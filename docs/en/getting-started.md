# Getting started

**English** | [简体中文](../zh-CN/getting-started.md)

MaybeCode normally asks before executing commands or modifying files. Start with
`maybecode --yolo` to enable automatic tool approval. Use `--no-yolo` to override
a configured YOLO default. In a session, `/yolo` or `/yolo on` enables the mode,
`/yolo off` disables it, and `/yolo status` shows it. Pause or cancel active work
before changing modes. The terminal and
Web UI display `YOLO · Auto-approve` while enabled; Web UI also has a Permissions
selector. See [permission configuration](reference/configuration.md#maybecode-permission-mode)
for scope, restart behavior, and retained restrictions.

This guide runs a May Agent locally, then turns the same model-and-tool loop
into a resumable headless application. It targets the current `0.1.0`
developer-preview API in this repository.

For the design choices behind each component, continue with
[Building an Agent](guides/building-an-agent.md). For the runtime vocabulary,
see [Runtime and session boundaries](architecture/runtime-session.md).

## Prerequisites

- Node.js 22.16.0 or newer for repository development (Node.js 24 recommended;
  `.node-version` records the recommended major version). The offline suite uses
  `node:sqlite` backup APIs available from Node.js 22.16.0.
- pnpm 12.4.2 (the repository pins its expected version in `package.json`)
- a checkout of this repository

Install and build the workspace from its root:

```bash
pnpm install
pnpm build
```

The existing deterministic example needs no API key and demonstrates one
`Model -> Tool -> Model` run:

```bash
pnpm example
```

Its source is [`examples/basic/basic.mjs`](../../examples/basic/basic.mjs). That
example uses `@may/core` directly, which is the right level for a one-shot or
embedded loop. The rest of this guide uses `@may/application`, the recommended
starting point for a product that needs a Session, permissions, history, or a
UI-independent lifecycle.

## Run the local MaybeCode build from PowerShell

Add the following line to `$PROFILE.CurrentUserAllHosts`, replacing the checkout
path with your own. PowerShell 7 and Windows PowerShell use separate profiles.

```powershell
. 'E:\code\May\scripts\maybecode-powershell.ps1'
```

Open a new terminal or load that profile with `. $PROFILE.CurrentUserAllHosts`.
Build after changing source files, then start MaybeCode from the project you
want to work on:

```powershell
pnpm --dir E:\code\May build
Set-Location E:\code\your-project
pnpm maybecode
```

The PowerShell function routes `pnpm maybecode` directly to this checkout's
`apps/maybecode/dist/bin.js`, preserves the current working directory, and forwards
arguments such as `--continue`, `--config`, and `--ui web`. Each launch uses the
latest successful build; restart an existing process after rebuilding. A missing
entry point reports the build command. This shortcut does not build automatically
or require a global MaybeCode installation. Other pnpm commands use `pnpm.cmd`.
Inside the May checkout, `pnpm run maybecode` still builds and starts the app through
the package script. Terminals started with `-NoProfile` must load the script explicitly.

The standalone `maybecode` executable remains the entry point supplied by an
installed package. To remove a previous global development installation, use
`pnpm remove --global @may/maybecode`.

## Send input during MaybeCode execution

Ordinary input cancels the current operation, waits for cancellation, and starts
the new request in the same Session. Use `/steer <message>` to finish the current
Step, including its tools and approvals, before delivering additional input.
Steering messages are saved and delivered in FIFO order. An idle `/steer` starts
a Run; messages that remain after completion or a host yield start in order
after the active operation finishes.

`/stop` and the Web cancel control cancel the current operation and queued input.
In a terminal, `Ctrl+C` without a text selection does the same. Cancelled
steering messages remain in history and need an explicit new submission to run.
These controls are available in classic TUI, retained TUI, and Web UI.

## Browse MaybeCode conversations

In the default retained TUI, use the mouse wheel to scroll the conversation.
Each event moves three rows and keeps the current input text and keyboard focus.
Scrolling up preserves the reading position while new output arrives. Scrolling
back to the bottom resumes following new output. Mouse scrolling requires a
terminal supporting xterm mouse reporting.

Up/Down in the input editor navigates input history. Press Tab to focus the
conversation, then use Up/Down, PageUp/PageDown, Home, or End to browse it.

Press `Ctrl+G`, then `R` to jump to the start of the current turn's completed
final reply body, after its thinking and tool activity. It places the body at
the top of the conversation and preserves your draft and keyboard focus.
The reading position stays there until you scroll; repeating the shortcut
returns to the same start. This also works after resuming a session and for
replies longer than the normal scroll buffer. If the current turn has no
completed final reply, the status shows `No final reply yet`.

Drag to select conversation text or input text. `Ctrl+C` copies a selection;
without one, it interrupts the run or exits the idle interface. In the editor,
`Ctrl+A` selects all, `Ctrl+X` cuts, and `Ctrl+V` pastes. Shift+arrows and
Shift+Home/End extend the selection. Home/End move to the current logical line's
beginning/end; typing or pasting replaces selected text. Dragging at a viewport
edge scrolls the selection. Code indentation and original line breaks are preserved.

`Ctrl+G D` toggles tool details and `Ctrl+G T` toggles reasoning. After the leader,
MaybeCode waits for the next key without a
time limit and preserves the reading position. Escape, focus changes, mouse
navigation and opening a dialog cancel the sequence and clear its hint. Configure the
single modified leader key with `MAY_TUI_LEADER`; text editing shortcuts are
reserved. `MAY_CLIPBOARD=auto` uses the local system clipboard. Other modes are
`system`, `osc52`, and `disabled`. Over SSH, explicitly select `osc52` and enable
clipboard writes in the terminal; use terminal paste for reading the clipboard.
OSC 52 writes cannot confirm terminal acceptance. Terminal-owned keybindings may
need adjustment so application shortcuts reach MaybeCode.

## Continuous integration

The [GitHub Actions workflow](../../.github/workflows/ci.yml) runs automatically
on pushes and pull requests. Once it is on the default branch, it can also be
started from **Actions → CI → Run workflow**. Each run checks four environments:
Linux with Node.js 22 and 24, and Windows and macOS with Node.js 24.
View each job's logs in the Actions tab or
follow the checks on a pull request to diagnose failures.

Each environment installs dependencies with `pnpm install --frozen-lockfile`,
then runs `pnpm build` and the offline suite once. Linux with Node.js 24 also
runs `pnpm docs:check`, WebUI resource synchronization and MCP Apps browser
isolation checks, the basic example, and the May and MaybeClaw
CLI help checks. Browser checks use headless Chromium. Examples and CLI checks
use built files directly. The offline suite already checks MaybeCode CLI help.
For local changes, use `pnpm --filter <package-name> test` for the affected package.
Separate Linux and Windows jobs use the recommended Node.js
version from `.node-version` and `pnpm test:package:maybecode` to verify
packed dependencies, MCP subpath exports, and the installed CLI outside the
repository. May packages come from local tarballs; external dependencies reuse
the pnpm store when available and download missing versions from the registry.

`pnpm test` continues through all workspace packages before reporting failures.
Single-Session tool, skills, compaction and retry tests configure
`subagents: false`; cancellation coverage also exercises the default delegation
workflow. System clipboard checks require a desktop session and are run manually
with `powershell -NoProfile -STA -File scripts/test-terminal-clipboard.ps1`.
MaybeClaw live-provider checks use `pnpm --filter @may/maybeclaw test:integration`
with `MAYBECLAW_LIVE_MODEL` and provider credentials. These desktop and live checks
are outside the default offline suite.
`pnpm test:path-alias` runs the entire suite with a temporary directory alias
(a Windows junction or a POSIX symlink), exposing assumptions about canonical
paths even on machines whose default temporary directory has no alias. On manual
dispatch, this replaces the regular suite in the Windows job; automatic runs
omit it. Coverage and package checks can also be run locally when needed with
`pnpm test:coverage` and `pnpm test:package:maybecode`.

The workflow needs no provider API keys and does not run live provider
integration tests or publish packages. Installation still needs access to the
package registry. The matrix is a validation target; actual support is confirmed
by successful runs. Real-terminal input, shortcuts, and resizing still require
manual verification.

## Create a workspace package

Create `examples/quickstart-agent/package.json`. The root
`pnpm-workspace.yaml` already includes every direct child of `examples/`.

```json
{
  "name": "@may/example-quickstart-agent",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node agent.mjs"
  },
  "dependencies": {
    "@may/application": "workspace:*",
    "@may/core": "workspace:*",
    "@may/session": "workspace:*"
  }
}
```

These are direct dependencies of this example:

- `@may/application` owns the headless Agent and Session lifecycle;
- `@may/core` supplies the `Model` and `Tool` contracts referenced by the
  example's JSDoc types;
- `@may/session` supplies the in-memory history store.

`workspace:*` is appropriate while developing inside this monorepo. A consumer
outside the repository should use published package versions when they become
available instead.

Run `pnpm install` once more after adding the package so pnpm creates its
workspace links.

## Add a minimal Agent application

Create `examples/quickstart-agent/agent.mjs`:

```js
import { defineAgent } from "@may/application";
import { ToolRegistry } from "@may/core";
import { InMemorySessionStore } from "@may/session";

/** @type {import("@may/core").Model} */
const model = {
  async *stream(request) {
    const latest = request.messages.at(-1);

    if (latest?.role === "tool") {
      const output = latest.content.find((part) => part.type === "json")?.value;
      const text = `The result is ${String(output)}.`;
      yield { type: "text.delta", delta: text };
      yield {
        type: "response.completed",
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
        },
      };
      return;
    }

    yield {
      type: "response.completed",
      message: {
        role: "assistant",
        content: [],
        toolCalls: [
          { id: "call_add", name: "add", input: { a: 20, b: 22 } },
        ],
      },
    };
  },
};

/** @type {import("@may/core").Tool<{a: number, b: number}, number>} */
const add = {
  name: "add",
  description: "Add two numbers",
  inputSchema: {
    type: "object",
    properties: {
      a: { type: "number" },
      b: { type: "number" },
    },
    required: ["a", "b"],
    additionalProperties: false,
  },
  parse(input) {
    if (
      typeof input !== "object" || input === null ||
      typeof input.a !== "number" || typeof input.b !== "number"
    ) {
      throw new TypeError("a and b must be numbers");
    }
    return { a: input.a, b: input.b };
  },
  async execute({ a, b }) {
    return a + b;
  },
};

const store = new InMemorySessionStore();
const tools = new ToolRegistry([add]);
const agent = defineAgent({
  model,
  tools,
  instructions: "Use the add tool and answer concisely.",
  // Safe only because every tool in this deterministic example is trusted.
  permissionPolicy: () => "allow",
  sessionHistory: false,
});

const application = await agent.open({ store });
const sessionId = application.sessionId;

try {
  const run = await application.submit({ input: "What is 20 + 22?" });
  const eventsDone = consumeRunEvents(application.events, run.id);
  const result = await run.result;
  await eventsDone;

  const text = result.message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  console.log(`\nFinal: ${text}`);
  console.log(`Session events: ${(await application.history()).length}`);
} finally {
  await application.close();
}

// An in-memory store can resume while this process and store object remain alive.
const resumed = await agent.open({
  store,
  sessionId,
  resume: true,
});
try {
  console.log(`Resumed session: ${resumed.sessionId}`);
  console.log(`Restored events: ${(await resumed.history()).length}`);
} finally {
  await resumed.close();
}

async function consumeRunEvents(events, runId) {
  for await (const applicationEvent of events) {
    if (applicationEvent.type !== "run.event") continue;

    const event = applicationEvent.event;
    if (event.runId !== runId) continue;
    if (event.type === "model.text.delta") process.stdout.write(event.delta);
    if (
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled"
    ) {
      return;
    }
  }
}
```

Run it from the repository root:

```bash
pnpm --filter @may/example-quickstart-agent start
```

The deterministic `model` makes this example reproducible without network
access. In a real Agent, replace it with one of May's provider adapters and add
that adapter as a direct dependency. For example, the live DeepSeek wiring is
shown in [`examples/deepseek/deepseek.mjs`](../../examples/deepseek/deepseek.mjs)
and requires `@may/provider-deepseek`, `DEEPSEEK_API_KEY`, and a supported model
name.

## What the example constructed

The code supplies the behavior and policy that a reusable lifecycle cannot
choose on its own:

```text
AgentDefinition
  + Model                 how model requests are answered
  + Iterable<Tool>        capabilities available to the model
  + instructions          product behavior
  + PermissionPolicy      whether each validated tool call may execute
  + ContextFactory        omitted here, so the in-memory default is used
       |
       `- open({ SessionStore }) -> AgentApplication for one Session
```

`defineAgent()` separates reusable behavior and policy from Session-bound
infrastructure. It consumes and snapshots the tools iterable immediately, so
later additions to `tools` would not change this definition. Each
`agent.open()` call creates an independent `AgentApplication` and a new Session
unless `resume: true` and a `sessionId` are supplied. It installs the
permission executor, creates the Core runtime, relays events, and connects
history and Context management.

`ToolRegistry` is useful when several features contribute tools and duplicate
names must fail early. It is an ordinary instance, not global state. An array,
set, generator, or any other `Iterable<Tool>` is also accepted.

The definition reuses the same Tool, Model, and other collaborator objects; it
does not clone them. Keep Tool descriptors stable after registration. If a
Model, Context factory, custom executor/scheduler, or other collaborator is
stateful, the caller must make it safe to share across opened applications or
create a separate definition for each ownership boundary.

The example explicitly disables the optional `session_history` tool. Pass
`sessionHistory: {}` instead when the model should be able to query bounded
pages from its durable Session history.

## Events and results are different interfaces

`application.submit()` returns a Promise for an `AgentRun`. The run then has
two independent observation paths:

- `run.result` is the authoritative final `RunResult` and rejects on failure;
- `application.events` is the live application stream used by a terminal,
  graphical UI, logger, or approval handler.

The application stream wraps Core events as `run.event`, permission events as
`permission.event`, and can also report tool presentations and Context
compaction. Consume it concurrently with the run rather than waiting for the
application stream to end: the stream remains open for later runs and closes
only when the application closes. Streaming deltas may be dropped under
buffer pressure, so never reconstruct the authoritative final answer solely
from deltas.

If a permission policy returns `"ask"` (or a scoped ask), an event consumer
must handle `approval.requested` and call
`application.resolveApproval(requestId, decision)`. Otherwise the tool call
correctly remains suspended.

## Persist across process restarts

`InMemorySessionStore` is useful for examples and tests. Replace it with the
Node.js file store when history must survive a restart:

```js
import { FileSessionStore } from "@may/session/file-store";

const store = new FileSessionStore(".may/sessions");
```

The package dependency remains `@may/session`; `file-store` is an exported
subpath of that package. Keep the returned Session id somewhere discoverable,
or add an `AgentWorkspace` and a Session Catalog as described in
[Building an Agent](guides/building-an-agent.md#single-session-or-workspace).

The built-in file store writes plaintext JSONL and assumes one active writer
per Session. It is a local backend, not encrypted multi-process storage.

## Always close the owner

Use `try`/`finally` around every opened `AgentApplication`. `close()`:

- cancels an active run or Context compaction;
- rejects pending approvals;
- waits for run and permission event relays;
- closes the application event stream.

Closing does **not** delete Session history. A resumed application reconstructs
the model-visible conversation from that history while applying the model,
tools, instructions, and policies supplied by the current product version.

If `AgentWorkspace` owns the active application, close the workspace instead;
it closes its application and waits for catalog recording and event relays.

## Next steps

- Read [Building an Agent](guides/building-an-agent.md) before selecting
  persistence, permissions, Context policies, or a UI.
- Read the [`@may/core` README](../../packages/core/README.md) for the low-level
  run loop and tool-executor seam.
- Read the [`@may/application` README](../../packages/application/README.md) for
  the single- and multi-Session lifecycle.
- Read the [`@may/session` README](../../packages/session/README.md) before relying
  on file persistence or catalogs.
