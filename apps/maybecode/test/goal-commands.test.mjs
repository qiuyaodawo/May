import assert from "node:assert/strict";
import test from "node:test";
import { parseGoalStart, formatGoal } from "../dist/goal-commands.js";
import { parseMaybeCodeSlashCommand, matchMaybeCodeSlashCommands } from "../dist/slash-commands.js";

test("goal command registration and budget arguments preserve the objective", () => {
  assert.equal(parseMaybeCodeSlashCommand("/goal pause").definition.name, "/goal");
  assert.deepEqual(matchMaybeCodeSlashCommands("/go").map(value => value.value), ["/goal"]);
  assert.deepEqual(parseGoalStart(["检查", "README.md"]), { objective: "检查 README.md", budget: {} });
  assert.deepEqual(parseGoalStart(["--tokens", "20000", "--max-runs", "4", "--", "检查", "README.md"]), {
    objective: "检查 README.md", budget: { maxTotalTokens: 20000, maxRuns: 4 },
  });
  for (const args of [[], ["--tokens"], ["--tokens", "0", "task"], ["--tokens", "1.5", "task"], ["--other", "1", "task"], ["--max-runs", "2", "--max-runs", "3", "task"]]) assert.throws(() => parseGoalStart(args));
  assert.equal(formatGoal(undefined), "No goal has been created.");
});
