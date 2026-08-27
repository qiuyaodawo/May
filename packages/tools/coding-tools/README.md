# `@may/coding-tools`

Basic filesystem and shell tools for May coding agents:

- `read`: read a range from a UTF-8 text file
- `bash`: run a shell command and capture its output
- `edit`: replace one exact, unique text occurrence
- `write`: create or overwrite a UTF-8 text file

Each tool is created for one workspace. Filesystem tools reject paths and
symbolic links that escape that workspace.

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
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@may/coding-tools";

const read = createReadTool({ cwd: process.cwd(), maxBytes: 2_000_000 });
```

## Safety boundaries

File sizes, returned line counts, command timeouts, and captured command output
are bounded and configurable. Runtime cancellation is forwarded to filesystem
operations and terminates the spawned command tree.

`bash` is **not a sandbox**. It executes with the permissions of the May
process and inherits its environment by default. An application that runs
untrusted commands must add its own sandbox and approval policy.
