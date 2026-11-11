import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import which from "which";
import { openCodingExecutionEnvironment, createCodingTool } from "@sortedyuan/coding-tools";
import { openLanguageServerManager } from "../../dist/index.js";

const signal = () => new AbortController().signal;
const context = {
  runId: "integration",
  step: 1,
  toolCallId: "integration",
  idempotencyKey: "integration",
  signal: signal(),
  report() {},
};
const installations = {
  rust: "rustup component add rust-analyzer rust-src",
  go: "go install golang.org/x/tools/gopls@latest",
};
async function requireCommand(id, command) {
  const path = await which(command, { nothrow: true });
  assert.ok(path, `${command} is required. Install: ${installations[id]}`);
  const child = spawn(path, [command === "gopls" ? "version" : "--version"], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (data) => {
    output += data.toString();
  });
  child.stderr.on("data", (data) => {
    output += data.toString();
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, `${command} is unavailable: ${output}. Install: ${installations[id]}`);
}

for (const mode of ["host", "container"]) {
  for (const id of ["rust", "go"]) {
    test(
      `${id} ${mode}: diagnostics, definition, references and rename${id === "go" ? " in a nested module" : ""}`,
      {
        timeout: 180000,
        skip:
          mode === "container" && !process.env.MAY_LSP_TEST_IMAGE
            ? "Set MAY_LSP_TEST_IMAGE to an offline image containing rust-analyzer, rust-src, gopls and Go"
            : false,
      },
      async (t) => {
        if (mode === "host") await requireCommand(id, id === "rust" ? "rust-analyzer" : "gopls");
        const base = resolve(import.meta.dirname, "../../.test-output/integration");
        await mkdir(base, { recursive: true });
        const workspace = await mkdtemp(join(base, `${id}-`));
        const directory = id === "go" ? "nested" : "src";
        await mkdir(join(workspace, directory));
        if (id === "rust")
          await writeFile(
            join(workspace, "Cargo.toml"),
            '[package]\nname = "lsp_test"\nversion = "0.1.0"\nedition = "2021"\n',
          );
        else await writeFile(join(workspace, "nested/go.mod"), "module example.com/lsp_test\n\ngo 1.22\n");
        const file = id === "rust" ? "src/lib.rs" : "nested/main.go";
        const good =
          id === "rust"
            ? "pub fn greet() -> i32 { 1 }\npub fn result() -> i32 { greet() }\n"
            : "package main\nfunc greet() int { return 1 }\nfunc result() int { return greet() }\n";
        await writeFile(join(workspace, file), good);
        const isolation =
          mode === "host"
            ? { mode: "host" }
            : {
                mode: "container",
                image: process.env.MAY_LSP_TEST_IMAGE,
                network: "none",
                memoryBytes: 2 * 1024 ** 3,
                cpuCount: 2,
              };
        const execution = await openCodingExecutionEnvironment({
          workspace,
          isolation,
          cacheDirectory: join(workspace, ".cache"),
        });
        const manager = await openLanguageServerManager({
          execution,
          servers: [{ id }],
          dataDirectory: join(workspace, ".data"),
          requestTimeoutMs: 60000,
          diagnosticsTimeoutMs: 60000,
        });
        t.after(async () => {
          await manager.close();
          await execution.close();
          await rm(workspace, { recursive: true, force: true });
        });
        const write = createCodingTool("write", { cwd: workspace, fileFeedback: manager.fileFeedback });
        const badText =
          id === "rust" ? good.replace("{ 1 }", '{ "wrong" }') : good.replace("return 1", 'return "wrong"');
        const bad = await write.execute({ path: file, content: badText }, context);
        assert.ok(
          bad.diagnostics.items.some((item) => item.severity === "error"),
          JSON.stringify(bad.diagnostics),
        );
        await write.execute({ path: file, content: good }, context);
        const position = { path: file, line: id === "rust" ? 2 : 3, symbol: "greet" };
        assert.ok((await manager.definition(position, signal())).length);
        assert.ok((await manager.references(position, true, signal())).locations.length >= 2);
        const plan = await manager.planRename(position, "welcome", signal());
        await manager.executeRename(plan, signal());
        assert.match(await readFile(join(workspace, file), "utf8"), /welcome/u);
        if (mode === "container") {
          const child = execution.spawn(
            "node",
            [
              "-e",
              'fetch("https://example.com", {signal: AbortSignal.timeout(2000)}).then(() => process.exit(1), () => process.exit(0))',
            ],
            { cwd: workspace, signal: signal() },
          );
          assert.equal((await once(child, "exit"))[0], 0, "Container network must be unavailable");
        }
      },
    );
  }
}
