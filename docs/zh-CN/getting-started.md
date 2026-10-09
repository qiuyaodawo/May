# 运行第一个 Agent 应用

[English](../en/getting-started.md) | **简体中文**

创建一个调用真实模型的 Agent，通过工具计算加法并保存对话历史，然后使用同一个
内存存储重新打开 Session。需要具备基础 JavaScript 知识，以及能够访问 API 的
DeepSeek 账户。

## 准备工作目录

使用本仓库、Node.js 22.16.0 或更新版本，以及 pnpm 12.4.2。推荐使用 Node.js 24
进行开发。在仓库根目录执行：

```bash
pnpm install
pnpm build
```

构建成功后才能运行导入 May package 的代码。仓库测试与 CI 见
[仓库开发](guides/repository-development.md)，编码应用操作见
[使用 MaybeCode](guides/maybecode.md)。

## 创建工作目录中的 package

创建 `examples/quickstart-agent/package.json`，填写以下内容。工作目录配置已经
包含 `examples/` 的直接子目录。

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

在仓库根目录执行 `pnpm install`，为新增 package 创建链接。`workspace:*` 使用
本仓库的 package；仓库外部的使用者需要选择可用的发布版本，并使用相同的公开
导入路径。

## 添加 Agent

创建 `examples/quickstart-agent/agent.mjs`：

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

`inputSchema` 向模型描述工具，`parse()` 校验实际参数。权限策略仅允许这个加法工具，
`maxSteps` 限制模型和工具循环的次数。`close()` 等待应用工作结束并释放应用管理的
资源；传入的存储继续保留，可用于重新打开 Session。

## 运行与核查结果

在本地环境设置 `DEEPSEEK_API_KEY`，将 `DEEPSEEK_MODEL` 设置为账户支持的模型 ID。
凭据应保存在源文件和 Git 之外。例如，在 PowerShell 中执行：

```powershell
$env:DEEPSEEK_MODEL = 'your-supported-model-id'
pnpm --filter @may/example-quickstart-agent start
```

执行前替换 `your-supported-model-id`。程序会向 DeepSeek 发送真实请求，使用账户
的 API 额度。

程序检查保存的 `add` 工具 `tool.completed` 事件，要求输出为 `42`。
核查回答是否包含 `42`、两次 Session ID 是否相同，以及恢复后的历史是否包含已保存
事件。模型措辞、ID 和事件数量可能变化。重新打开时读取历史，不发送新的模型请求。
缺少环境变量时，程序在打开应用前报错。认证、网络或模型错误会使 Run 失败，需要
根据错误信息检查账户设置。

## 跨进程重新启动时保存历史

内存存储在当前进程与存储对象存在期间保留历史。需要写入文件时，替换
`InMemorySessionStore` 的导入与构造代码：

```js
import { FileSessionStore } from "@may/session/file-store";

const store = new FileSessionStore(".may/sessions");
```

保存 Session ID 后，可以在其他进程中重新打开。文件存储使用明文 JSONL，每个
Session 支持一个活动写入者。存储要求见[Session 存储](guides/custom-storage.md)，
通过 Session Catalog 发现会话的方法见[构建 Agent](guides/building-an-agent.md)。

## 继续完成相关任务

- [构建 Agent](guides/building-an-agent.md)：选择工具、权限、Context 管理、存储和 UI。
- [理解 Session、Run 与 Step](concepts/session-run-step.md)：理解执行单位。
- [消费应用事件](concepts/events.md)：提供进度或审批 UI。需要审批的权限策略要求
  同时运行事件处理程序。
- [使用 MaybeCode](guides/maybecode.md)：操作参考编码应用。
