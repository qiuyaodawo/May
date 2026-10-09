# `@may/coding-tools`

Basic filesystem and shell tools for May coding agents:

- `read`: read a range from a UTF-8 text file
- `shell`: run a platform-appropriate shell command and capture its output
- `edit`: replace one exact, unique text occurrence
- `write`: create or overwrite a UTF-8 text file

Each tool is created for one workspace. Filesystem tools reject paths and
symbolic links that escape that workspace. Existing hard-linked files are also
rejected by default because a path-only check cannot prove that every link is
inside the workspace. Trusted applications may opt in per tool with
`allowHardLinks: true`.

```ts
import { InMemoryContext, May } from "@may/core";
import { createCodingTools } from "@may/coding-tools";

const tools = createCodingTools({ cwd: process.cwd() });

const may = new May({
  model,
  tools,
  context: new InMemoryContext(),
});
```

`createCodingTools` creates all four tools; passing them to `May` registers
them for that runtime instance. The package does not maintain a global tool
registry.

Individual factories are also available:

Trusted host policies can reuse `resolveExistingWorkspacePath()` and
`resolveWritableWorkspacePath()` from the package root. Both return the checked
physical `absolute` path and display `relative` path, and enforce the same workspace/link checks as the
file tools. Use these results when deriving persistent file permission ranges.

```ts
import {
  createEditTool,
  createReadTool,
  createShellTool,
  createWriteTool,
} from "@may/coding-tools";

const read = createReadTool({ cwd: process.cwd(), maxBytes: 2_000_000 });
```

## Change previews

Approval UIs can preview an `edit` or `write` call without performing it:

```ts
import { createToolChangePreview } from "@may/coding-tools/change-preview";

const preview = await createToolChangePreview(process.cwd(), "edit", {
  path: "src/index.ts",
  oldText: "before",
  newText: "after",
});
```

The preview validates the workspace boundary and file shape, rejects unsafe
linked files, and returns a bounded unified diff with addition/deletion counts.
`decodeToolChangePreviewPresentation` validates previews restored from durable
session presentation events. The persisted presentation identifier remains
compatible with MaybeCode sessions created before this component was extracted.

## Coding instructions

Applications can compose bounded, strict UTF-8 system, runtime, and
directory-scoped project instruction documents without coupling prompt policy to a
specific agent product:

```ts
import {
  codingRuntimeInstructions,
  loadCodingInstructions,
} from "@may/coding-tools/instructions";
import { createShellTool, getShellToolInfo } from "@may/coding-tools";

const shell = createShellTool({ cwd: process.cwd() });
const shellInfo = getShellToolInfo(shell);

const instructions = await loadCodingInstructions({
  workspace: process.cwd(),
  defaultSystemInstructions: "You are a coding agent.",
  runtimeInstructions: codingRuntimeInstructions({
    workspace: process.cwd(),
    ...(shellInfo === undefined ? {} : { shell: shellInfo }),
    agentRole: "main agent",
    sessionOrigin: "new session",
    permissionMode: "ask",
  }),
  projectInstructionsFilename: "AGENTS.md",
  projectInstructionsFallbackFilenames: [],
  projectRootMarkers: [".git"],
  sectionLabels: {
    runtime: "Runtime environment",
    project: "Project instructions",
  },
  maxBytes: 32 * 1024,
});
```

An explicit `systemInstructions` value takes precedence over a `system.md`
loaded from `instructionsDirectory`; otherwise the application-provided default
is used.

`workspace` is the application's starting or current directory. Project
discovery walks upward to the nearest directory containing a
`projectRootMarkers` entry; the default is `[".git"]`. Marker files and
directories are both recognized, including a worktree's `.git` file. Without
a marker, or with `projectRootMarkers: []`, only `workspace` is searched.
Discovery then visits each directory from that project root through
`workspace`, without scanning sibling or descendant directories or searching
above the project root.

Each directory contributes at most one nonempty document, selected in this
order: `AGENTS.override.md`, `projectInstructionsFilename` (default
`AGENTS.md`), then `projectInstructionsFallbackFilenames` in their configured
order (default `[]`). Missing and empty candidates are skipped. Parent
documents precede child documents; instructions specify that deeper-directory
rules take priority when project rules conflict. Each selected document is
preceded by `Source: <absolute file path>` in the composed project section.
Multiple documents also include their directory scope. Use
`formatCodingProjectInstructions(projects, label?)` to produce this section
independently. `projectInstructionsFilename: false` disables the entire
project discovery chain, including overrides and fallback files.

`CodingInstructions.projects` contains all selected documents in parent-to-child
order. `project` retains the document from the closest selected directory for
existing callers. Use `projects` or `effective` to consume the complete rule
chain. The default `maxBytes` is 32 KiB: each instruction document and the
combined project document bodies, including separating blank lines, must fit
that limit. Oversized content raises an error. Strict UTF-8 validation and the
rejection of symbolic links, reparse points, and hard links apply to every
selected instruction file. Loading ancestor instructions does not expand
filesystem-tool workspace boundaries.

`codingRuntimeInstructions` returns runtime text without a Markdown heading.
It resolves the workspace to an absolute path, names the current operating
system, and includes shell metadata and syntax guidance when `shell` is supplied.
The default Agent role is `main agent` and the default Session origin is
`new session`. Applications can provide `sub-agent`, `resumed session`, or
`historical branch`, along with `assignedRole`, `parentTask`, `historicalSource`,
and `permissionMode` when applicable. Historical branches include guidance to
read current files before relying on historical file contents.

`shellRuntimeInstructions` provides syntax guidance for the configured shell.
The tool description provides its execution purpose and host permissions;
the shell name appears in the runtime metadata.
Applications can call these functions again when runtime state or instruction
files change.

`getShellToolInfo` also works with tools captured by `ToolRegistry.snapshot()`.
It returns a copy of the shell metadata. The metadata is kept outside the
model-facing tool definitions.

## Safety boundaries

File sizes, returned line counts, command timeouts, and captured command output
are bounded and configurable. Runtime cancellation is forwarded to filesystem
operations and terminates the spawned command tree.

`shell` uses Windows PowerShell on Windows and Bash on other supported
platforms. Its dynamic tool description and MaybeCode's generated runtime
instructions tell the model which syntax to use. PowerShell is launched
directly with UTF-8 stdout/stderr rather than through `cmd.exe`.

For PowerShell, `exitCode` is `0` when the final command succeeds. If the final
command fails, the latest native process exit code is preserved when it is
nonzero; otherwise the result is `1`. An explicit `exit N` returns `N`. A successful
command after a non-terminating error returns `0`, while the earlier error output
remains in `stderr`.

Pass a `ShellProfile` to select another executable. `createPowerShellProfile`
and `createBashShellProfile` provide the built-in launch conventions.
`createBashTool` remains as a deprecated compatibility factory and now means a
real Bash executable rather than the platform's implicit default shell.

`shell` executes with May process permissions and inherits its environment.
Applications that require execution isolation must provide a separate sandbox
or remote execution backend.
