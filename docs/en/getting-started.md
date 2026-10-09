# Run your first Agent application

**English** | [简体中文](../zh-CN/getting-started.md)

Create an Agent that calls a real model, calculates a sum with a tool, and saves
conversation history. Then reopen its Session using the same in-memory store.
You need basic JavaScript knowledge and a DeepSeek account with API access.

## Prepare the workspace

Use a checkout of this repository, Node.js 22.16.0 or newer, and pnpm 12.4.2.
Node.js 24 is the recommended development version. Run these commands from the
repository root:

```bash
pnpm install
pnpm build
```

The build must finish successfully before running code that imports May packages.
For repository tests and CI, see [Repository development](guides/repository-development.md).
For the coding application, see [Use MaybeCode](guides/maybecode.md).

## Create a workspace package

Create `examples/quickstart-agent/package.json` with this content. The workspace
already includes direct children of `examples/`.

```json
{
  "name": "@may/example-quickstart-agent",
  "private": true,
  "type": "module",
  "scripts": { "start": "node agent.mjs" },
  "dependencies": {
    "@may/application": "workspace:*",
    "@may/core": "workspace:*",
    "@may/provider-deepseek": "workspace:*",
    "@may/session": "workspace:*"
  }
}
```

Run `pnpm install` from the repository root to create the new package's links.
`workspace:*` resolves local packages in this checkout. An external consumer must
use available published versions and the same public import paths.

## Add the Agent

Create `examples/quickstart-agent/agent.mjs`:

```js
import { defineAgent } from "@may/application";
import { ToolRegistry } from "@may/core";
import { DeepSeekModel } from "@may/provider-deepseek";
import { InMemorySessionStore } from "@may/session";

const apiKey = process.env.DEEPSEEK_API_KEY;
const modelName = process.env.DEEPSEEK_MODEL;
if (!apiKey || !modelName) {
  throw new Error("Set DEEPSEEK_API_KEY and DEEPSEEK_MODEL");
}

/** @type {import("@may/core").Tool<{a: number, b: number}, number>} */
const add = {
  name: "add",
  description: "Add two finite numbers",
  inputSchema: {
    type: "object",
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
    additionalProperties: false,
  },
  parse(input) {
    if (
      typeof input !== "object" || input === null ||
      !("a" in input) || !("b" in input) ||
      typeof input.a !== "number" || typeof input.b !== "number" ||
      !Number.isFinite(input.a) || !Number.isFinite(input.b)
    ) {
      throw new TypeError("a and b must be finite numbers");
    }
    return { a: input.a, b: input.b };
  },
  async execute({ a, b }, context) {
    context.signal.throwIfAborted();
    return a + b;
  },
};

const store = new InMemorySessionStore();
const agent = defineAgent({
  model: new DeepSeekModel({ apiKey, model: modelName }),
  tools: new ToolRegistry([add]),
  instructions: "Use add for arithmetic and answer with the result.",
  permissionPolicy: ({ tool }) => tool.name === "add" ? "allow" : "deny",
  maxSteps: 4,
});

const application = await agent.open({ store });
const sessionId = application.sessionId;
try {
  const run = await application.submit({ input: "Use add to calculate 20 + 22." });
  const result = await run.result;
  const text = result.message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  console.log(`Answer: ${text}`);
  console.log(`Session: ${sessionId}`);
  const history = await application.history();
  const addition = history.find(event =>
    event.type === "tool.completed" && event.call.name === "add");
  if (addition?.type !== "tool.completed" || addition.output !== 42) {
    throw new Error("The Run must complete add with output 42");
  }
  console.log(`Tool result: ${addition.output}`);
  console.log(`Saved events: ${history.length}`);
} finally {
  await application.close();
}

const resumed = await agent.open({ store, sessionId, resume: true });
try {
  console.log(`Resumed Session: ${resumed.sessionId}`);
  console.log(`Restored events: ${(await resumed.history()).length}`);
} finally {
  await resumed.close();
}
```

`inputSchema` describes the tool to the model. `parse()` validates the actual
arguments. The policy allows only this arithmetic tool, and `maxSteps` bounds the
model/tool loop. `close()` waits for application work and releases its lifecycle
resources; the injected store remains available for reopening the Session.

## Run and check the result

Set `DEEPSEEK_API_KEY` in your local environment and set `DEEPSEEK_MODEL` to a model
ID supported by your account. Keep credentials out of source files and Git.
For example, in PowerShell:

```powershell
$env:DEEPSEEK_MODEL = 'your-supported-model-id'
pnpm --filter @may/example-quickstart-agent start
```

Replace `your-supported-model-id` before running. The program sends live requests
to DeepSeek and uses the account's API allowance.

The program verifies a saved `tool.completed` event for `add` with output `42`.
Check that the answer contains `42`, the two Session IDs match, and the restored
history contains the saved events. Model wording, IDs, and event counts can vary.
Reopening reads history and does not send another model request. A missing
environment value fails before opening the application. Authentication, network,
or model errors fail the Run; inspect the reported error and your account settings.

## Persist across process restarts

The in-memory store retains history while this process and store object exist.
To save it on disk, replace the `InMemorySessionStore` import and construction:

```js
import { FileSessionStore } from "@may/session/file-store";

const store = new FileSessionStore(".may/sessions");
```

Keep the saved Session ID to reopen it in another process. The file store uses
plaintext JSONL and supports one active writer per Session. Use
[Session storage](guides/custom-storage.md) for storage requirements and
[Building an Agent](guides/building-an-agent.md) for discovery with a Session Catalog.

## Follow the next task

- [Build an Agent](guides/building-an-agent.md) to choose tools, permissions,
  Context management, storage, and UI.
- [Understand Session, Run, and Step](concepts/session-run-step.md) to understand
  the execution units.
- [Consume application events](concepts/events.md) for progress or approval UI.
  A policy that asks for approval requires a concurrent event handler.
- [Use MaybeCode](guides/maybecode.md) to work with the reference coding product.
