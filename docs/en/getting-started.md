# Run your first Agent application

**English** | [简体中文](../zh-CN/getting-started.md)

Create an Agent that calls a real model, calculates a sum with a tool, and saves
conversation history. Then reopen its Session using the same in-memory store.
You need basic JavaScript knowledge and a DeepSeek account with API access.

## Prepare the project directory

Use Node.js 22.16.0 or newer and npm. Create an empty directory and enter it:

```bash
mkdir quickstart-agent
cd quickstart-agent
```

To work on May itself, see [Repository development](guides/repository-development.md).
For the coding application, see [Use MaybeCode](guides/maybecode.md).

## Install the packages

Create `package.json` with this content:

```json
{
  "name": "quickstart-agent",
  "private": true,
  "type": "module",
  "scripts": { "start": "node agent.mjs" },
  "dependencies": {
    "@sortedyuan/may": "^0.2.0",
    "@sortedyuan/providers": "^0.4.0",
    "zod": "^4.6.7"
  }
}
```

Run `npm install` in the directory. It installs May, the provider adapters, and
Zod from the npm registry.

## Add the Agent

Create `agent.mjs` in the same directory:

```js
import { defineAgent } from "@sortedyuan/may";
import { defineTool, ToolRegistry } from "@sortedyuan/may/core";
import { z } from "zod";
import { DeepSeekModel } from "@sortedyuan/providers/deepseek";
import { InMemorySessionStore } from "@sortedyuan/may/session";

const apiKey = process.env.DEEPSEEK_API_KEY;
const modelName = process.env.DEEPSEEK_MODEL;
if (!apiKey || !modelName) {
  throw new Error("Set DEEPSEEK_API_KEY and DEEPSEEK_MODEL");
}

const add = defineTool({
  name: "add",
  description: "Add two finite numbers",
  schema: z.strictObject({ a: z.number(), b: z.number() }),
  async execute({ a, b }, context) {
    context.signal.throwIfAborted();
    return a + b;
  },
});

const store = new InMemorySessionStore();
const agent = defineAgent({
  model: new DeepSeekModel({ apiKey, model: modelName }),
  tools: new ToolRegistry([add]),
  instructions: "Use add for arithmetic and answer with the result.",
  permissionPolicy: ({ tool }) => (tool.name === "add" ? "allow" : "deny"),
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
  const addition = history.find((event) => event.type === "tool.completed" && event.call.name === "add");
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

The Zod `schema` describes the tool input to the model, and `defineTool` validates
the actual arguments against it. The policy allows only this arithmetic tool, and `maxSteps` bounds the
model/tool loop. `close()` waits for application work and releases its lifecycle
resources; the injected store remains available for reopening the Session.

## Run and check the result

Set `DEEPSEEK_API_KEY` in your local environment and set `DEEPSEEK_MODEL` to a model
ID supported by your account. Keep credentials out of source files and Git.
For example, in PowerShell:

```powershell
$env:DEEPSEEK_MODEL = 'your-supported-model-id'
npm start
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
import { FileSessionStore } from "@sortedyuan/may/session/file-store";

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
