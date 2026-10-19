import assert from "node:assert/strict";
import test from "node:test";
import { renderDelegationTask, formatDelegationTree, formatDelegationRequests } from "../dist/delegation-commands.js";

test("任务通知、请求通知和查询显示状态字段", () => {
  const task = { id: "request", role: "main", depth: 1, status: "completed", output: "### Commands\n\n**read** `file.ts`\n\n| Command | Result |\n| --- | --- |\n| read | ok |" };
  const state = { requestId: "excerpt", status: "completed", tasks: [task] };
  for (const text of [renderDelegationTask(task), formatDelegationTree(state), formatDelegationRequests([state])]) {
    assert.ok(text.includes("request [main] completed"));
    assert.doesNotMatch(text, /result:|Commands|file.ts/u);
  }
  assert.doesNotMatch(renderDelegationTask({ ...task, output: "\n\n" }), /result:/u);
  const long = renderDelegationTask({ ...task, depth: 2, parentTaskId: "request", output: "**" + "字".repeat(401) + "**" });
  assert.equal(long, "  request [main] completed parent request");
});
