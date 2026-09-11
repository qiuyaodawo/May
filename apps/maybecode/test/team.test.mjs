import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseMaybeCodeArgs, runMaybeCodeTeamCommand } from "../dist/index.js";

test("team CLI validates bounded options without changing normal startup", () => {
  assert.deepEqual(parseMaybeCodeArgs(["team", "run", "inspect", "--workspace", ".", "--max-concurrent", "2"]), {
    type: "team", action: "run", value: "inspect", workspace: ".", maxConcurrent: 2,
  });
  for (const args of [
    ["team", "run"], ["team", "resume", "../outside"], ["team", "run", "inspect", "--max-concurrent", "9"],
    ["team", "run", "inspect", "--max-model-calls", "1.5"], ["team", "resume", "id", "--model", "changed"],
  ]) assert.throws(() => parseMaybeCodeArgs(args));
  assert.equal(parseMaybeCodeArgs(["--model", "chat", "."]).type, "start");
});

test("team entry runs isolated workers plus supervisor, persists artifacts/budget, and resumes without replay", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "maybecode-team-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, "source");
  const dataDirectory = join(directory, "state");
  await mkdir(workspace);
  await writeFile(join(workspace, "README.md"), "fixture evidence");
  await writeFile(join(workspace, ".env"), "SHOULD_NOT_LEAK=secret");
  const config = { path: join(directory, "config.json"), providers: { fake: { adapter: "openai-responses", apiKey: "private-test-key" } },
    models: { test: { provider: "fake", model: "fixture" } }, defaultModel: "test" };
  let calls = 0;
  let output = "";
  const dependencies = {
    loadConfig: async () => config,
    write: (text) => { output += text; },
    createModel: () => ({ async *stream(request) {
      calls++;
      assert.ok(!request.tools.some((tool) => ["shell", "edit", "write"].includes(tool.name)));
      const completedRead = request.messages.some((message) => message.role === "tool");
      yield { type: "response.completed", message: { role: "assistant", content: completedRead
        ? [{ type: "text", text: "Found fixture evidence in README.md; analysis and review agree." }]
        : [], ...(completedRead ? {} : { toolCalls: [{ id: "read-source", name: "read", input: { path: "README.md" } }] }) },
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
    } }),
  };
  assert.equal(await runMaybeCodeTeamCommand({ type: "team", action: "run", value: "Inspect README.md", workspace, dataDirectory, maxConcurrent: 1 }, dependencies), 0);
  assert.equal(calls, 6);
  assert.match(output, /\[analysis\] completed/u);
  assert.match(output, /\[review\] completed/u);
  assert.match(output, /\[summary\] completed/u);
  assert.match(output, /"modelCalls":6/u);
  assert.ok(!output.includes("private-test-key"));
  assert.equal(await readFile(join(workspace, "README.md"), "utf8"), "fixture evidence");
  const [id] = await readdir(join(dataDirectory, "teams"));
  assert.equal(await runMaybeCodeTeamCommand({ type: "team", action: "resume", value: id, dataDirectory }, dependencies), 0);
  assert.equal(calls, 6, "completed durable inputs must not call the model again");
  assert.equal(await runMaybeCodeTeamCommand({ type: "team", action: "status", value: id, dataDirectory }, dependencies), 0);
  assert.equal(await runMaybeCodeTeamCommand({ type: "team", action: "cancel", value: id, dataDirectory }, dependencies), 0);
  assert.equal(JSON.parse(await readFile(join(dataDirectory, "teams", id, "cancel.request.json"), "utf8")).id, id);
  const artifacts = output.match(/Artifact \[/gu) ?? [];
  assert.equal(artifacts.length, 6, "each run/resume reports all three immutable outputs");
});
