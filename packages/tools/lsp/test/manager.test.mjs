import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { once } from "node:events";
import { spawn, fork } from "node:child_process";
import { createRequire } from "node:module";
import { SharedWorkspaceFileGuard } from "@sortedyuan/coordination/delegation/files";
import test from "node:test";
import {
  createCodingTool,
  openCodingExecutionEnvironment,
  resolveExistingWorkspacePath,
} from "@sortedyuan/coding-tools";
import {
  openLanguageServerManager,
  createLspTools,
  createRenamePreview,
  LspRenameConflictError,
  LspServerNotFoundError,
  LspTimeoutError,
} from "../dist/index.js";

const signal = () => new AbortController().signal;
const context = (toolCallId = "test") => ({
  runId: "test",
  step: 1,
  toolCallId,
  idempotencyKey: toolCallId,
  signal: signal(),
  report() {},
});
async function fixture(
  t,
  servers = [{ id: "typescript" }],
  options = {},
  base = resolve(import.meta.dirname, "../.test-output"),
) {
  await mkdir(base, { recursive: true });
  const workspace = await mkdtemp(join(base, "lsp-"));
  const execution = await openCodingExecutionEnvironment({ workspace, isolation: { mode: "host" } });
  const manager = await openLanguageServerManager({
    execution,
    servers,
    dataDirectory: join(workspace, ".data"),
    diagnosticsTimeoutMs: 15000,
    requestTimeoutMs: 30000,
    ...options,
  });
  t.after(async () => {
    await manager.close();
    await execution.close();
    await rm(workspace, { force: true, recursive: true });
  });
  return { workspace, manager, execution };
}
async function project(workspace) {
  await writeFile(
    join(workspace, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022" },
      include: ["*.ts"],
    }),
  );
  await writeFile(join(workspace, "a.ts"), "export function greet(name: string): string { return name; }\n");
  await writeFile(join(workspace, "b.ts"), 'import { greet } from "./a.js";\nexport const result = greet("hello");\n');
}

test("TypeScript write/edit feedback and all seven LSP tools use a real server", { timeout: 120000 }, async (t) => {
  const { workspace, manager } = await fixture(t);
  await project(workspace);
  const write = createCodingTool("write", { cwd: workspace, fileFeedback: manager.fileFeedback });
  const bad = await write.execute({ path: "error.ts", content: 'const count: number = "wrong";\n' }, context());
  assert.equal(bad.diagnostics.status, "unknown", bad.diagnostics.reason);
  assert.ok(bad.diagnostics.items.some((item) => item.severity === "error"));
  const edit = createCodingTool("edit", { cwd: workspace, fileFeedback: manager.fileFeedback });
  const fixed = await edit.execute({ path: "error.ts", oldText: '"wrong"', newText: "1" }, context());
  assert.equal(fixed.diagnostics.status, "unknown");
  assert.deepEqual(fixed.diagnostics.items, []);
  const tools = createLspTools(manager);
  assert.equal(tools.length, 7);
  const run = (name, input, id) => {
    const tool = tools.find((tool) => tool.name === name);
    return tool.execute(tool.parse(input), context(id));
  };
  const definition = await run("lsp_definition", { path: "b.ts", line: 2, symbol: "greet" });
  assert.equal(definition.locations[0].path, "a.ts");
  const refs = await run("lsp_references", { path: "a.ts", line: 1, column: 17, includeDeclaration: true });
  assert.ok(refs.locations.some((entry) => entry.path === "b.ts"));
  assert.match((await run("lsp_hover", { path: "a.ts", line: 1, symbol: "greet" })).text, /greet/u);
  assert.ok((await run("lsp_document_symbols", { path: "a.ts" })).symbols.some((entry) => entry.name === "greet"));
  assert.ok(
    (await run("lsp_workspace_symbols", { language: "typescript", query: "greet" })).symbols.some(
      (entry) => entry.name === "greet",
    ),
  );
  assert.equal((await run("lsp_diagnostics", { path: "error.ts" })).status, "unknown");
  const input = { path: "a.ts", line: 1, symbol: "greet", newName: "welcome" };
  const preview = await createRenamePreview(manager, input, "rename");
  assert.equal(preview.files.length, 2);
  assert.ok(preview.files.every((file) => file.diff.includes("welcome")));
  const renamed = await run("lsp_rename", input, "rename");
  assert.equal(renamed.files.length, 2);
  assert.match(await readFile(join(workspace, "a.ts"), "utf8"), /function welcome/u);
  assert.match(await readFile(join(workspace, "b.ts"), "utf8"), /welcome\("hello"\)/u);
  const plan = await manager.planRename({ path: "a.ts", line: 1, symbol: "welcome" }, "changed", signal());
  const before = await readFile(join(workspace, "a.ts"), "utf8");
  await writeFile(
    join(workspace, "b.ts"),
    "// changed outside tool\n" + (await readFile(join(workspace, "b.ts"), "utf8")),
  );
  await assert.rejects(manager.executeRename(plan, signal()), LspRenameConflictError);
  assert.equal(await readFile(join(workspace, "a.ts"), "utf8"), before);
  await writeFile(
    join(workspace, "b.ts"),
    'import { welcome } from "./a.js";\nexport const result = welcome("hello");\nwelcome("again");\n',
  );
  const updated = await manager.references({ path: "a.ts", line: 1, symbol: "welcome" }, false, signal());
  assert.ok(updated.locations.some((entry) => entry.path === "b.ts" && entry.line === 3));
  const pid = manager.status()[0].pid;
  await manager.close();
  assert.throws(() => process.kill(pid, 0));
});

test("Python diagnostics and queries use pyright --stdio", { timeout: 120000 }, async (t) => {
  const { workspace, manager } = await fixture(t, [{ id: "python" }]);
  await writeFile(join(workspace, "pyrightconfig.json"), JSON.stringify({ typeCheckingMode: "strict" }));
  const write = createCodingTool("write", { cwd: workspace, fileFeedback: manager.fileFeedback });
  const bad = await write.execute({ path: "main.py", content: 'count: int = "wrong"\n' }, context());
  assert.equal(bad.diagnostics.status, "complete");
  assert.ok(bad.diagnostics.items.some((item) => item.severity === "error"));
  const fixed = await write.execute({ path: "main.py", content: "count: int = 1\n" }, context());
  assert.equal(fixed.diagnostics.status, "complete");
  assert.deepEqual(fixed.diagnostics.items, []);
  assert.match(
    (await manager.hover({ path: "main.py", line: 1, symbol: "count" }, signal())).text,
    /count: Literal\[1\]/u,
  );
});

test("feedback reserves ordered versions for rapid writes", { timeout: 120000 }, async (t) => {
  const { workspace, manager } = await fixture(t);
  await project(workspace);
  const path = await resolveExistingWorkspacePath(workspace, "a.ts");
  const contents = ["export const value: number = 1;\n", "export const value: string = 2;\n"];
  await writeFile(path.absolute, contents[0]);
  const first = manager.fileFeedback.record(path, contents[0]);
  await writeFile(path.absolute, contents[1]);
  const second = manager.fileFeedback.record(path, contents[1]);
  const results = await Promise.all([first.result(signal()), second.result(signal())]);
  assert.equal(results[0].diagnostics.status, "pending");
  assert.equal(results[1].diagnostics.status, "unknown");
  assert.ok(results[1].diagnostics.items.some((item) => item.severity === "error"));
  const syncs = manager
    .status()[0]
    .logs.split("\n")
    .filter((line) => line.startsWith("Document sync "));
  assert.equal(syncs.length, 2);
  assert.match(syncs[0], /version 1$/u);
  assert.match(syncs[1], /version 2$/u);
});

test("path, size, symbol and tool input checks fail at the boundary", { timeout: 120000 }, async (t) => {
  const { workspace, manager } = await fixture(t, [{ id: "typescript" }], { maxFileBytes: 256 });
  await project(workspace);
  await assert.rejects(manager.diagnostics("../outside.ts", signal()), /outside/iu);
  await writeFile(join(workspace, "large.ts"), " ".repeat(257));
  await assert.rejects(manager.diagnostics("large.ts", signal()), /byte limit/u);
  await assert.rejects(manager.hover({ path: "a.ts", line: 1, symbol: "missing" }, signal()), /line: export/u);
  const tool = createLspTools(manager).find((tool) => tool.name === "lsp_definition");
  assert.throws(() => tool.parse({ path: "a.ts", line: 1, column: 1, symbol: "greet" }));
  assert.throws(() => tool.parse({ path: "a.ts", line: 1 }));
});

test("missing server includes installation guidance", async (t) => {
  const { workspace, manager } = await fixture(t, [{ id: "python", command: "may-nonexistent-language-server" }]);
  await writeFile(join(workspace, "main.py"), "value = 1\n");
  await assert.rejects(
    manager.hover({ path: "main.py", line: 1, symbol: "value" }, signal()),
    (error) => error instanceof LspServerNotFoundError && error.message.includes("npm install -g pyright"),
  );
});

test("rename uses the shared workspace guard to enforce every assigned path", { timeout: 120000 }, async (t) => {
  const { workspace, manager } = await fixture(t);
  await project(workspace);
  await manager.documentSymbols("b.ts", signal());
  const plan = await manager.planRename({ path: "a.ts", line: 1, symbol: "greet" }, "welcome", signal());
  const factories = Object.fromEntries(
    createLspTools(manager).map((tool) => [
      tool.name,
      (guard) => createLspTools(manager, { guard }).find((entry) => entry.name === tool.name),
    ]),
  );
  const shared = new SharedWorkspaceFileGuard(workspace, {
    fileFeedback: manager.fileFeedback,
    toolFactories: factories,
  });
  const restricted = shared.create({ names: ["lsp_rename"], files: ["a.ts"], requireRead: false });
  const input = { path: "a.ts", line: 1, symbol: "greet", newName: "welcome" };
  const tool = restricted.tools[0];
  manager.cacheRename("restricted", input, plan);
  await assert.rejects(tool.execute(input, context("restricted")), /outside its assigned files/u);
  assert.match(await readFile(join(workspace, "a.ts"), "utf8"), /function greet/u);
  assert.match(await readFile(join(workspace, "b.ts"), "utf8"), /greet\("hello"\)/u);
  const allowed = shared.create({ names: ["lsp_rename"], files: ["a.ts", "b.ts"], requireRead: false });
  const result = await allowed.tools[0].execute(input, context("allowed"));
  assert.equal(result.files.length, 2);
  assert.deepEqual(allowed.changedFiles().sort(), ["a.ts", "b.ts"]);
});

test(
  "server capacity closes the least recently used server and restarts it on demand",
  { timeout: 120000 },
  async (t) => {
    const { workspace, manager } = await fixture(t, [{ id: "typescript" }, { id: "python" }], { maxServers: 1 });
    await project(workspace);
    await writeFile(join(workspace, "main.py"), "value = 1\n");
    await manager.hover({ path: "a.ts", line: 1, symbol: "greet" }, signal());
    const firstPid = manager.status()[0].pid;
    await manager.hover({ path: "main.py", line: 1, symbol: "value" }, signal());
    assert.throws(() => process.kill(firstPid, 0));
    assert.deepEqual(
      manager.status().map((entry) => entry.state),
      ["stopped", "running"],
    );
    await manager.hover({ path: "a.ts", line: 1, symbol: "greet" }, signal());
    assert.deepEqual(
      manager.status().map((entry) => entry.state),
      ["running", "stopped"],
    );
  },
);

test("Unicode paths and UTF-16 positions preserve occurrences and bounded outputs", { timeout: 120000 }, async (t) => {
  const { workspace, manager } = await fixture(t, [{ id: "typescript" }], { maxHoverChars: 12, maxResults: 1 });
  await project(workspace);
  const path = "中文 space.ts";
  await writeFile(join(workspace, path), 'export const emoji = "😀"; export const value = emoji + emoji;\n');
  const bySymbol = await manager.definition({ path, line: 1, symbol: "emoji", occurrence: 3 }, signal());
  const text = await readFile(join(workspace, path), "utf8");
  const byColumn = await manager.definition({ path, line: 1, column: text.lastIndexOf("emoji") + 1 }, signal());
  assert.deepEqual(byColumn, bySymbol);
  assert.equal(bySymbol[0].path, path);
  const hover = await manager.hover({ path, line: 1, symbol: "value" }, signal());
  assert.equal(hover.text.length, 12);
  assert.equal(hover.truncated, true);
  const refs = await manager.references({ path, line: 1, symbol: "emoji" }, true, signal());
  assert.equal(refs.locations.length, 1);
  assert.equal(refs.truncated, true);
});

test(
  "short request timeout returns LspTimeoutError and caller cancellation returns its reason",
  { timeout: 120000 },
  async (t) => {
    const { workspace, manager } = await fixture(t, [{ id: "typescript" }], { requestTimeoutMs: 1 });
    await project(workspace);
    await assert.rejects(manager.hover({ path: "a.ts", line: 1, symbol: "greet" }, signal()), LspTimeoutError);
    const controller = new AbortController();
    controller.abort(new Error("cancelled by caller"));
    await assert.rejects(
      manager.hover({ path: "a.ts", line: 1, symbol: "greet" }, controller.signal),
      /cancelled by caller/u,
    );
    await manager.close();
    assert.match(manager.status()[0].logs, /Sending notification '\$\/cancelRequest'/u);
  },
);

test(
  "rename recovery restores files after the real process stops before its second write",
  { timeout: 120000 },
  async (t) => {
    const { workspace, manager } = await fixture(t);
    await project(workspace);
    await manager.close();
    const originalA = await readFile(join(workspace, "a.ts"), "utf8");
    const originalB = await readFile(join(workspace, "b.ts"), "utf8");
    const child = fork(new URL("./rename-child.mjs", import.meta.url), [workspace], {
      execArgv: ["--inspect=0"],
      silent: true,
    });
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    const inspectorUrl = await new Promise((accept, reject) => {
      let stderr = "";
      child.stderr.on("data", (data) => {
        stderr += data.toString();
        const found = stderr.match(/ws:\/\/[^\s]+/u);
        if (found) accept(found[0]);
      });
      child.once("error", reject);
    });
    const socket = new WebSocket(inspectorUrl);
    await once(socket, "open");
    t.after(() => socket.close());
    let sequence = 0;
    const pending = new Map();
    let paused;
    const stoppedAtBreakpoint = new Promise((accept) => {
      paused = accept;
    });
    socket.addEventListener("message", (event) => {
      const value = JSON.parse(event.data);
      if (value.id) {
        const completion = pending.get(value.id);
        pending.delete(value.id);
        value.error ? completion.reject(new Error(value.error.message)) : completion.accept(value.result);
      }
      if (value.method === "Debugger.paused") paused(value.params);
    });
    const command = (method, params = {}) =>
      new Promise((accept, reject) => {
        const id = ++sequence;
        pending.set(id, { accept, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    await command("Debugger.enable");
    const [ready] = await once(child, "message");
    assert.equal(ready.files.length, 2);
    const second = ready.files[1];
    await command("Debugger.setBreakpointByUrl", {
      urlRegex: "[/\\\\]atomic-write\\.js$",
      lineNumber: 8,
      condition: `path.endsWith(${JSON.stringify(second)})`,
    });
    child.send("execute");
    await stoppedAtBreakpoint;
    const first = ready.files[0];
    assert.match(await readFile(join(workspace, first), "utf8"), /welcome/u);
    assert.equal(await readFile(join(workspace, second), "utf8"), second === "a.ts" ? originalA : originalB);
    if (process.platform === "win32")
      await once(spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }), "exit");
    else {
      child.kill("SIGKILL");
      process.kill(ready.serverPid, "SIGKILL");
    }
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    socket.close();
    const execution = await openCodingExecutionEnvironment({ workspace, isolation: { mode: "host" } });
    const recovered = await openLanguageServerManager({
      execution,
      servers: [{ id: "typescript" }],
      dataDirectory: join(workspace, ".data"),
    });
    try {
      assert.equal(await readFile(join(workspace, "a.ts"), "utf8"), originalA);
      assert.equal(await readFile(join(workspace, "b.ts"), "utf8"), originalB);
      assert.match(recovered.status()[0].recovery, /Recovered rename transaction/u);
    } finally {
      await recovered.close();
      await execution.close();
    }
  },
);

test(
  "Windows global npm .cmd resolution runs pyright from a path with spaces",
  { skip: process.platform !== "win32", timeout: 120000 },
  async (t) => {
    const base = resolve(import.meta.dirname, "../../../../.test-output/lsp-global");
    const { workspace, execution } = await fixture(t, [], {}, base);
    const prefix = join(workspace, "global npm prefix");
    const npm = join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
    const installed = createRequire(import.meta.url).resolve("pyright/package.json");
    const installation = spawn(
      process.execPath,
      [
        npm,
        "install",
        "--global",
        "--prefix",
        prefix,
        "--offline",
        "--omit=optional",
        "--ignore-scripts",
        dirname(installed),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    installation.stdout.on("data", (data) => {
      output += data.toString();
    });
    installation.stderr.on("data", (data) => {
      output += data.toString();
    });
    const [code] = await once(installation, "exit");
    assert.equal(code, 0, output);
    const oldPath = process.env.PATH;
    process.env.PATH = `${prefix};${oldPath}`;
    const manager = await openLanguageServerManager({
      execution,
      servers: [{ id: "python" }],
      dataDirectory: join(workspace, ".global-data"),
    });
    try {
      await writeFile(join(workspace, "main.py"), "value: int = 1\n");
      assert.match((await manager.hover({ path: "main.py", line: 1, symbol: "value" }, signal())).text, /value/u);
      assert.ok(manager.status()[0].args[0].includes("global npm prefix"));
      assert.ok(manager.status()[0].args[0].endsWith("langserver.index.js"));
    } finally {
      process.env.PATH = oldPath;
      await manager.close();
    }
  },
);

test("three rapid server exits stop automatic restarts until restart is requested", { timeout: 120000 }, async (t) => {
  const { workspace, manager } = await fixture(t);
  await project(workspace);
  for (let count = 0; count < 3; count++) {
    await manager.hover({ path: "a.ts", line: 1, symbol: "greet" }, signal());
    const pid = manager.status()[0].pid;
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      await once(killer, "exit");
    } else {
      process.kill(pid, "SIGKILL");
      await assert.rejects(manager.hover({ path: "a.ts", line: 1, symbol: "greet" }, signal()));
    }
  }
  assert.equal(manager.status()[0].state, "failed");
  await manager.restart("typescript");
  assert.match((await manager.hover({ path: "a.ts", line: 1, symbol: "greet" }, signal())).text, /greet/u);
});
