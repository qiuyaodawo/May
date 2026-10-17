import assert from "node:assert/strict";
import test from "node:test";
import { renderDelegationTask, formatDelegationTree, formatDelegationRequests } from "../dist/delegation-commands.js";

test("任务通知、请求通知和查询统一使用 Markdown 纯文本节选", () => {
  const task = { id: "request", role: "main", depth: 1, status: "completed", output: "### Commands\n\n**read** `file.ts`\n\n| Command | Result |\n| --- | --- |\n| read | ok |" };
  const state = { requestId: "excerpt", status: "completed", tasks: [task] };
  const expected = "    result:\n      Commands\n      \n      read file.ts\n      \n      Command: read; Result: ok";
  for (const text of [renderDelegationTask(task), formatDelegationTree(state), formatDelegationRequests([state])]) {
    assert.ok(text.includes(expected));
    assert.doesNotMatch(text, /###|\*\*|`|\| ---/u);
  }
  assert.doesNotMatch(renderDelegationTask({ ...task, output: "\n\n" }), /result:/u);
  const long = renderDelegationTask({ ...task, depth: 2, parentTaskId: "request", output: "**" + "字".repeat(401) + "**" });
  assert.ok(long.endsWith("字".repeat(399) + "…"));
});
