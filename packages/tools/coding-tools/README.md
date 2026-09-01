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

## Safety boundaries

File sizes, returned line counts, command timeouts, and captured command output
are bounded and configurable. Runtime cancellation is forwarded to filesystem
operations and terminates the spawned command tree.

`shell` uses Windows PowerShell on Windows and Bash on other supported
platforms. Its dynamic tool description and MaybeCode's generated runtime
instructions tell the model which syntax to use. PowerShell is launched
directly with UTF-8 stdout/stderr rather than through `cmd.exe`.

Pass a `ShellProfile` to select another executable. `createPowerShellProfile`
and `createBashShellProfile` provide the built-in launch conventions.
`createBashTool` remains as a deprecated compatibility factory and now means a
real Bash executable rather than the platform's implicit default shell.

`shell` is **not a sandbox**. It executes with the permissions of the May
process and inherits its environment by default. An application that runs
untrusted commands must add its own sandbox and approval policy.
