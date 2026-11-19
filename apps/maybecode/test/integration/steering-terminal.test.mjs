import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { until } from "@sortedyuan/test-support";
import test from "node:test";
import { NodeTerminalDriver } from "@sortedyuan/tui";
import { loadMayConfig } from "@sortedyuan/may/config";
import { openConfiguredMaybeCode } from "../../dist/index.js";
import { runRetainedTerminalUI } from "../../dist/ui/retained-tui.js";
import { liveModelProfile } from "../fixtures/live-model.mjs";

const base = fileURLToPath(new URL("../../../../.test-output/maybecode-steering-terminal/", import.meta.url));

test(
  "真实 retained 终端在执行期间接收补充消息、替换输入和 Ctrl+C",
  {
    timeout: 180_000,
  },
  async (t) => {
    await mkdir(base, { recursive: true });
    const directory = await mkdtemp(join(base, "case-"));
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "input.txt"), "Terminal steering verification file.\n");
    const config = await loadMayConfig();
    const app = await openConfiguredMaybeCode({
      git: false,
      workspace,
      dataDirectory: join(directory, "data"),
      configPath: config.path,
      model: liveModelProfile(),
      autoResume: false,
      goals: false,
      mcp: false,
      observability: false,
      skills: false,
      retry: false,
      runBudget: { maxSteps: 6, maxModelCalls: 6, maxToolCalls: 6, maxDurationMs: 90_000 },
    });
    const input = new PassThrough(),
      output = new PassThrough();
    let rendered = "";
    output.on("data", (chunk) => {
      rendered += chunk.toString();
    });
    const terminal = new NodeTerminalDriver({ input, output, requireTTY: false });
    const ui = runRetainedTerminalUI(app, { terminal });
    let finished = false;
    t.after(async () => {
      if (!finished) {
        app.cancel("Terminal verification cleanup");
        input.write("/quit\r\n");
      }
      try {
        await ui;
      } finally {
        terminal.close();
        input.destroy();
        output.destroy();
        await app.close();
      }
      assert.ok(resolve(directory).startsWith(resolve(base) + sep));
      await rm(directory, { recursive: true, force: true });
    });
    await until(t, () => rendered.includes("MaybeCode"));
    input.write("Use read to inspect input.txt, then reply ORIGINAL_RESPONSE. Do not use shell or modify files.\r\n");
    await until(t, () => app.isRunning);
    input.write("/steer After reading, reply exactly TERMINAL_STEERING_CONFIRMED.\r\n");
    await until(t, () => app.application.agent.listSteeringInputs().length === 1);
    await until(t, () => !app.isRunning && app.application.agent.listSteeringInputs()[0].status === "delivered");
    let history = await app.history();
    assert.ok(
      history.some(
        (event) =>
          event.type === "assistant.completed" &&
          event.message.content.some(
            (part) => part.type === "text" && part.text.includes("TERMINAL_STEERING_CONFIRMED"),
          ),
      ),
    );

    input.write("/steer Do not use tools. Reply exactly TERMINAL_IDLE_STEERING_CONFIRMED.\r\n");
    await until(t, () => app.isRunning);
    const idleOutputStart = rendered.length;
    await until(
      t,
      () =>
        !app.isRunning &&
        app.application.agent.listSteeringInputs().length === 2 &&
        app.application.agent.listSteeringInputs()[1].status === "delivered",
    );
    history = await app.history();
    assert.ok(
      history.some(
        (event) =>
          event.type === "assistant.completed" &&
          event.message.content.some(
            (part) => part.type === "text" && part.text.includes("TERMINAL_IDLE_STEERING_CONFIRMED"),
          ),
      ),
    );
    await until(t, () => rendered.slice(idleOutputStart).includes("Ready"));

    const cancelled = history.filter((event) => event.type === "run.cancelled").length;
    const runsBeforeReplacement = history.filter((event) => event.type === "run.started").length;
    input.write(
      "Use read to inspect input.txt, then explain every word in detail. Do not use shell or modify files.\r\n",
    );
    await until(
      t,
      async () =>
        app.isRunning &&
        (await app.history()).filter((event) => event.type === "run.started").length > runsBeforeReplacement,
    );
    input.write("Do not use tools. Reply exactly TERMINAL_REPLACEMENT_CONFIRMED.\r\n");
    await until(t, async () =>
      (await app.history()).some(
        (event) =>
          event.type === "input.submitted" &&
          event.message.content.some(
            (part) => part.type === "text" && part.text.includes("TERMINAL_REPLACEMENT_CONFIRMED"),
          ),
      ),
    );
    await until(t, () => !app.isRunning);
    history = await app.history();
    assert.ok(history.filter((event) => event.type === "run.cancelled").length > cancelled);
    assert.ok(
      history.some(
        (event) =>
          event.type === "assistant.completed" &&
          event.message.content.some(
            (part) => part.type === "text" && part.text.includes("TERMINAL_REPLACEMENT_CONFIRMED"),
          ),
      ),
    );

    const beforeInterrupt = history.filter((event) => event.type === "run.cancelled").length;
    const runsBeforeInterrupt = history.filter((event) => event.type === "run.started").length;
    input.write("Use read to inspect input.txt, then explain every word in detail.\r\n");
    await until(
      t,
      async () =>
        app.isRunning &&
        (await app.history()).filter((event) => event.type === "run.started").length > runsBeforeInterrupt,
    );
    input.write("TERMINAL_CANCEL_PENDING_FIRST\rTERMINAL_CANCEL_PENDING_SECOND\r\u0003");
    await until(t, () => !app.isRunning);
    history = await app.history();
    assert.ok(history.filter((event) => event.type === "run.cancelled").length > beforeInterrupt);
    assert.ok(
      !history.some(
        (event) =>
          event.type === "input.submitted" &&
          event.message.content.some((part) => part.type === "text" && part.text.includes("TERMINAL_CANCEL_PENDING_")),
      ),
    );
    input.write("/quit\r\n");
    await ui;
    finished = true;
  },
);
