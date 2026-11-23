import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createTestDirectory, until } from "@sortedyuan/test-support";
import { createShellTool, openCodingExecutionEnvironment } from "../dist/index.js";
import {
  runBoundedCommand,
  setHostProcessCloseTimeoutForTesting,
  terminateWindowsProcessTree,
  waitForProcessGroupExit,
} from "../dist/process-termination.js";

function isProcessExited(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error && error.code === "ESRCH") return true;
    throw error;
  }
}

test(
  "runBoundedCommand enforces hard wall-clock timeout against a real SIGTERM-ignoring child",
  { timeout: 5_000 },
  async () => {
    const started = performance.now();
    await assert.rejects(
      runBoundedCommand(
        process.execPath,
        ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 60_000);"],
        150,
      ),
      { code: "CODING_EXECUTION_TERMINATION_TIMEOUT" },
    );
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 2_000, `expected bounded command to time out promptly, took ${elapsed}ms`);
  },
);

test(
  "waitForProcessGroupExit bounds waiting on a real live POSIX process group and resolves on real ESRCH",
  { skip: process.platform === "win32", timeout: 10_000 },
  async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], {
      detached: true,
      stdio: "ignore",
    });
    const closed = new Promise((resolve) => child.once("close", resolve));
    try {
      const started = performance.now();
      await assert.rejects(waitForProcessGroupExit(child.pid, { timeoutMs: 80 }), {
        code: "CODING_EXECUTION_TERMINATION_TIMEOUT",
      });
      assert.ok(performance.now() - started < 2_000, "live process group wait must time out promptly");

      process.kill(-child.pid, "SIGKILL");
      await closed;
      await waitForProcessGroupExit(child.pid, { timeoutMs: 2_000 });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (!error || error.code !== "ESRCH") throw error;
        }
      }
      await closed;
    }
  },
);

test(
  "macOS waitForProcessGroupExit handles real EPERM via real /bin/ps and enforces deadline",
  { skip: process.platform !== "darwin" || process.getuid?.() === 0, timeout: 10_000 },
  async () => {
    const output = await runBoundedCommand("/bin/ps", ["-A", "-o", "uid=,pgid="], 2_000);
    let rootPgid;
    for (const line of output.split(/\r?\n/u)) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
      if (!match) continue;
      const uid = Number(match[1]);
      const pgid = Number(match[2]);
      if (uid !== 0 || pgid <= 1) continue;
      try {
        process.kill(-pgid, 0);
      } catch (error) {
        if (error && error.code === "EPERM") {
          rootPgid = pgid;
          break;
        }
      }
    }
    assert.ok(rootPgid !== undefined, "expected a real root-owned process group (pgid > 1) returning EPERM on macOS");

    const started = performance.now();
    await assert.rejects(waitForProcessGroupExit(rootPgid, { timeoutMs: 120 }), {
      code: "CODING_EXECUTION_TERMINATION_TIMEOUT",
    });
    assert.ok(performance.now() - started < 2_000, "macOS EPERM /bin/ps polling must honor deadline");
  },
);

test(
  "terminateWindowsProcessTree distinguishes timeout, failed exit, and real Windows taskkill behavior",
  { timeout: 10_000 },
  async (t) => {
    await assert.rejects(
      terminateWindowsProcessTree(1234, {
        timeoutMs: 120,
        spawnTaskkill: () =>
          spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], {
            windowsHide: true,
            stdio: "ignore",
          }),
      }),
      { code: "CODING_EXECUTION_TERMINATION_TIMEOUT" },
    );

    const exitedChild = spawn(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true, stdio: "ignore" });
    await new Promise((resolve) => exitedChild.once("close", resolve));
    await until(t, () => isProcessExited(exitedChild.pid));
    if (process.platform === "win32") {
      await terminateWindowsProcessTree(exitedChild.pid);
    } else {
      await terminateWindowsProcessTree(exitedChild.pid, {
        spawnTaskkill: () =>
          spawn(process.execPath, ["-e", "process.exit(128)"], { windowsHide: true, stdio: "ignore" }),
      });
    }

    const liveChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], {
      windowsHide: true,
      stdio: "ignore",
    });
    const liveClosed = new Promise((resolve) => liveChild.once("close", resolve));
    try {
      await assert.rejects(
        terminateWindowsProcessTree(liveChild.pid, {
          spawnTaskkill: () =>
            spawn(process.execPath, ["-e", "process.exit(1)"], { windowsHide: true, stdio: "ignore" }),
        }),
        { code: "CODING_EXECUTION_TERMINATION_FAILED" },
      );

      if (process.platform === "win32") {
        await terminateWindowsProcessTree(liveChild.pid);
        await liveClosed;
      }
    } finally {
      if (liveChild.exitCode === null && liveChild.signalCode === null) {
        try {
          process.kill(liveChild.pid, "SIGKILL");
        } catch (error) {
          if (!error || error.code !== "ESRCH") throw error;
        }
      }
      await liveClosed;
    }
  },
);

test(
  "Node host process exits promptly without hanging on abandoned child when real host termination fails",
  { timeout: 10_000 },
  async (t) => {
    const workspace = await createTestDirectory(t, "coding-tools/host-unref-exit");
    const pidFile = join(workspace, "live.pid");
    const resultFile = join(workspace, "result.json");
    const runnerFile = join(workspace, "host-runner.mjs");
    const indexUrl = new URL("../dist/index.js", import.meta.url).href;
    const termUrl = new URL("../dist/process-termination.js", import.meta.url).href;

    const isWin = process.platform === "win32";
    await writeFile(
      runnerFile,
      [
        `import { writeFileSync } from "node:fs";`,
        `import { openCodingExecutionEnvironment } from ${JSON.stringify(indexUrl)};`,
        `import { setHostProcessCloseTimeoutForTesting } from ${JSON.stringify(termUrl)};`,
        `const workspace = process.argv[2];`,
        `const pidFile = process.argv[3];`,
        `const resultFile = process.argv[4];`,
        `const repoRoot = process.argv[5];`,
        `const env = await openCodingExecutionEnvironment({ workspace, isolation: { mode: "host" } });`,
        `const controller = new AbortController();`,
        ...(isWin
          ? [
              `const child = env.spawn(process.execPath, ["-e", "setTimeout(() => {}, 15_000)"], { cwd: workspace, signal: controller.signal });`,
              `writeFileSync(pidFile, String(child.pid), "utf8");`,
            ]
          : [
              `setHostProcessCloseTimeoutForTesting(150);`,
              `const spawnScript = \`const { spawn } = require("node:child_process"); const { writeFileSync } = require("node:fs"); const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15_000)"], { cwd: process.argv[2], stdio: ["ignore", 1, 2], detached: true }); writeFileSync(process.argv[1], String(g.pid), "utf8"); g.unref(); process.exit(0);\`;`,
              `const child = env.spawn(process.execPath, ["-e", spawnScript, pidFile, repoRoot], { cwd: workspace, signal: controller.signal });`,
              `await new Promise((resolve) => child.once("exit", resolve));`,
            ]),
        `let errorCode = null;`,
        `try { await env.close(); } catch (error) { errorCode = error?.code ?? error?.message ?? "unknown"; }`,
        `writeFileSync(resultFile, JSON.stringify({ errorCode }), "utf8");`,
      ].join("\n"),
      "utf8",
    );

    const started = performance.now();
    const hostEnv = isWin ? { ...process.env, PATH: "", Path: "" } : process.env;
    const host = spawn(process.execPath, [runnerFile, workspace, pidFile, resultFile, process.cwd()], {
      cwd: process.cwd(),
      env: hostEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    host.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    let livePid;
    try {
      const [exitCode] = await new Promise((resolve, reject) => {
        host.once("error", reject);
        host.once("close", (code, signal) => resolve([code, signal]));
      });
      const elapsed = performance.now() - started;
      assert.equal(exitCode, 0, `host runner failed: ${stderr}`);
      assert.ok(
        elapsed < 4_000,
        `Node host must exit naturally without waiting 15s for abandoned child, took ${elapsed}ms`,
      );
      const result = JSON.parse(await readFile(resultFile, "utf8"));
      assert.equal(result.errorCode, isWin ? "ENOENT" : "CODING_EXECUTION_TERMINATION_TIMEOUT");
      livePid = Number((await readFile(pidFile, "utf8")).trim());
    } finally {
      if (livePid === undefined) {
        try {
          livePid = Number((await readFile(pidFile, "utf8")).trim());
        } catch {
          // PID file was not written.
        }
      }
      if (Number.isSafeInteger(livePid) && livePid > 0) {
        try {
          process.kill(livePid, "SIGKILL");
        } catch (error) {
          if (!error || error.code !== "ESRCH") throw error;
        }
        await until(t, () => isProcessExited(livePid));
      }
    }
  },
);

test(
  "standalone Node host catches CODING_TOOL_COMMAND_TIMEOUT from shell.execute() and exits naturally when termination fails",
  { timeout: 10_000 },
  async (t) => {
    const workspace = await createTestDirectory(t, "coding-tools/shell-timeout-host-exit");
    const pidFile = join(workspace, "live.pid");
    const resultFile = join(workspace, "result.json");
    const runnerFile = join(workspace, "shell-runner.mjs");
    const indexUrl = new URL("../dist/index.js", import.meta.url).href;
    const termUrl = new URL("../dist/process-termination.js", import.meta.url).href;

    const isWin = process.platform === "win32";
    await writeFile(
      runnerFile,
      [
        `import { writeFileSync } from "node:fs";`,
        `import { createShellTool, openCodingExecutionEnvironment } from ${JSON.stringify(indexUrl)};`,
        `import { setHostProcessCloseTimeoutForTesting } from ${JSON.stringify(termUrl)};`,
        `const workspace = process.argv[2];`,
        `const pidFile = process.argv[3];`,
        `const resultFile = process.argv[4];`,
        `const repoRoot = process.argv[5];`,
        ...(isWin ? [] : [`setHostProcessCloseTimeoutForTesting(150);`]),
        `const env = await openCodingExecutionEnvironment({ workspace, isolation: { mode: "host" } });`,
        `const shell = createShellTool({`,
        `  cwd: workspace,`,
        `  execution: env,`,
        `  profile: { kind: "custom", displayName: "node", executable: process.execPath, args: (code) => ["-e", code, pidFile, repoRoot] },`,
        `});`,
        `const cmd = ${JSON.stringify(
          isWin
            ? 'require("node:fs").writeFileSync(process.argv[1], String(process.pid), "utf8"); setTimeout(() => {}, 15_000);'
            : 'const { spawn } = require("node:child_process"); const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15_000)"], { cwd: process.argv[2], stdio: ["ignore", 1, 2], detached: true }); require("node:fs").writeFileSync(process.argv[1], String(g.pid), "utf8"); g.unref(); process.exit(0);',
        )};`,
        `let caught = false;`,
        `let errorCode = null;`,
        `try {`,
        `  await shell.execute({ command: cmd, timeoutMs: 400 }, { signal: new AbortController().signal, report() {} });`,
        `} catch (error) {`,
        `  caught = true;`,
        `  errorCode = error?.code ?? error?.message ?? "unknown";`,
        `}`,
        `writeFileSync(resultFile, JSON.stringify({ caught, errorCode }), "utf8");`,
      ].join("\n"),
      "utf8",
    );

    const started = performance.now();
    const hostEnv = isWin ? { ...process.env, PATH: "", Path: "" } : process.env;
    const host = spawn(process.execPath, [runnerFile, workspace, pidFile, resultFile, process.cwd()], {
      cwd: process.cwd(),
      env: hostEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    host.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    let livePid;
    try {
      const [exitCode] = await new Promise((resolve, reject) => {
        host.once("error", reject);
        host.once("close", (code, signal) => resolve([code, signal]));
      });
      const elapsed = performance.now() - started;
      assert.equal(exitCode, 0, `shell host runner failed: ${stderr}`);
      assert.doesNotMatch(stderr, /unsettled top-level await/i);
      assert.ok(elapsed < 4_000, `shell timeout host must exit naturally after catching error, took ${elapsed}ms`);
      const result = JSON.parse(await readFile(resultFile, "utf8"));
      assert.equal(result.caught, true);
      assert.equal(result.errorCode, "CODING_TOOL_COMMAND_TIMEOUT");
      livePid = Number((await readFile(pidFile, "utf8")).trim());
    } finally {
      if (livePid === undefined) {
        try {
          livePid = Number((await readFile(pidFile, "utf8")).trim());
        } catch {
          // PID file was not written.
        }
      }
      if (Number.isSafeInteger(livePid) && livePid > 0) {
        try {
          process.kill(livePid, "SIGKILL");
        } catch (error) {
          if (!error || error.code !== "ESRCH") throw error;
        }
        await until(t, () => isProcessExited(livePid));
      }
    }
  },
);

test(
  "environment.close() bounds pipe wait without mocking terminator after direct child exits while descendant holds pipes",
  { timeout: 10_000 },
  async (t) => {
    const workspace = await createTestDirectory(t, "coding-tools/post-exit-descendant-pipes");
    const pidFile = join(workspace, "grandchild.pid");
    const environment = await openCodingExecutionEnvironment({ workspace, isolation: { mode: "host" } });
    const controller = new AbortController();

    const script = `
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], {
      cwd: process.argv[2],
      stdio: ["ignore", 1, 2],
      detached: true,
      windowsHide: true,
    });
    writeFileSync(process.argv[1], String(grandchild.pid), "utf8");
    grandchild.unref();
    process.exit(0);
  `;
    const child = environment.spawn(process.execPath, ["-e", script, pidFile, process.cwd()], {
      cwd: workspace,
      signal: controller.signal,
    });

    await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(child.exitCode, 0);

    const grandchildPid = Number(await readFile(pidFile, "utf8"));
    assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0);
    setHostProcessCloseTimeoutForTesting(150);

    try {
      const started = performance.now();
      await assert.rejects(environment.close(), { code: "CODING_EXECUTION_TERMINATION_TIMEOUT" });
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 3_000, `environment.close() should bound pipe wait instead of hanging, took ${elapsed}ms`);
    } finally {
      setHostProcessCloseTimeoutForTesting(undefined);
      try {
        process.kill(grandchildPid, "SIGKILL");
      } catch (error) {
        if (!error || error.code !== "ESRCH") throw error;
      }
      await until(t, () => isProcessExited(grandchildPid));
    }
  },
);

test(
  "single cancelled shell command bounds pipe wait after direct child exits while descendant keeps stdio open",
  { timeout: 10_000 },
  async (t) => {
    const workspace = await createTestDirectory(t, "coding-tools/shell-cancel-pipes");
    const pidFile = join(workspace, "pids.json");
    const helperFile = join(workspace, "spawn-grandchild.cjs");
    await writeFile(
      helperFile,
      [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        'const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], {',
        "  cwd: process.argv[3],",
        '  stdio: ["ignore", 1, 2],',
        "  detached: true,",
        "  windowsHide: true,",
        "});",
        'writeFileSync(process.argv[2], JSON.stringify({ childPid: process.pid, grandchildPid: g.pid }), "utf8");',
        "g.unref();",
        "process.exit(0);",
      ].join("\n"),
      "utf8",
    );

    const environment = await openCodingExecutionEnvironment({ workspace, isolation: { mode: "host" } });
    const shell = createShellTool({
      cwd: workspace,
      execution: environment,
      profile: {
        kind: "custom",
        displayName: "node",
        executable: process.execPath,
        args: (scriptPath) => [scriptPath, pidFile, process.cwd()],
      },
    });
    const controller = new AbortController();
    setHostProcessCloseTimeoutForTesting(200);

    let grandchildPid;
    try {
      const runPromise = shell.execute({ command: helperFile }, { signal: controller.signal, report() {} });
      let earlyFailure;
      runPromise.catch((error) => {
        earlyFailure = error;
      });

      const pids = await until(t, async () => {
        if (earlyFailure !== undefined) throw earlyFailure;
        try {
          const parsed = JSON.parse(await readFile(pidFile, "utf8"));
          return Number.isSafeInteger(parsed.childPid) && Number.isSafeInteger(parsed.grandchildPid)
            ? parsed
            : undefined;
        } catch {
          return undefined;
        }
      });
      grandchildPid = pids.grandchildPid;

      await until(t, () => isProcessExited(pids.childPid));

      const cancelStarted = performance.now();
      controller.abort();
      await assert.rejects(runPromise, { code: "CODING_TOOL_CANCELLED" });
      const elapsed = performance.now() - cancelStarted;
      assert.ok(
        elapsed < 3_000,
        `cancelled shell command must fail promptly on open descendant pipes, took ${elapsed}ms`,
      );

      await assert.rejects(environment.close(), { code: "CODING_EXECUTION_TERMINATION_TIMEOUT" });
    } finally {
      setHostProcessCloseTimeoutForTesting(undefined);
      if (grandchildPid !== undefined) {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch (error) {
          if (!error || error.code !== "ESRCH") throw error;
        }
        await until(t, () => isProcessExited(grandchildPid));
      }
      await environment.close().catch(() => {});
    }
  },
);

test(
  "POSIX environment.close() kills same-process-group descendants holding pipes after direct child exits",
  { skip: process.platform === "win32", timeout: 10_000 },
  async (t) => {
    const workspace = await createTestDirectory(t, "coding-tools/posix-pgrp-post-exit");
    const environment = await openCodingExecutionEnvironment({ workspace, isolation: { mode: "host" } });
    const controller = new AbortController();
    const child = environment.spawn("sh", ["-c", "sleep 60 &"], {
      cwd: workspace,
      signal: controller.signal,
    });
    await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(child.exitCode, 0);
    const started = performance.now();
    await environment.close();
    assert.ok(performance.now() - started < 3_000, "POSIX process-group cleanup should finish promptly");
  },
);
