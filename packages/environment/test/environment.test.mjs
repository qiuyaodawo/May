import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { createLandstripEnvironment, createArtifactReference } from "../dist/index.js";

const review = fileURLToPath(new URL("../../../review/environment-mvp/tests/", import.meta.url));
const windows = { skip: process.platform !== "win32" };

async function fixture() {
  await mkdir(review, { recursive: true });
  const root = await mkdtemp(join(review, "environment-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  const sentinel = join(outside, "sentinel.txt");
  await writeFile(sentinel, "protected");
  return { root, workspace, outside, sentinel };
}

test("file access, actual commands, protected runtime and binary artifacts", windows, async () => {
  const f = await fixture();
  const environment = await createLandstripEnvironment({ workspace: f.workspace, requiredPrograms: [{ program: "node", expectedOutput: process.version }] });
  try {
    const description = await environment.describe();
    assert.equal(description.platform, "win32");
    assert.equal(description.isolation.network, "none");
    assert.equal(description.isolation.readScope, "platform-default");
    assert.equal(description.ownership.preservesHostWorkspaceOnClose, true);
    await environment.writeFile("nested/text.txt", "中文\n");
    assert.equal((await environment.readFile("nested/text.txt", { encoding: "utf8" })).text, "中文\n");
    assert.equal((await environment.statFile("nested/text.txt")).absolutePath, join(f.workspace, "nested", "text.txt"));
    await assert.rejects(environment.readFile("nested/text.txt", { maxBytes: 1 }), { code: "ENVIRONMENT_OUTPUT_TOO_LARGE" });
    await assert.rejects(environment.writeFile("../escape.txt", "escape"), { code: "ENVIRONMENT_INVALID_PATH" });
    await assert.rejects(environment.writeFile("nested/text.txt", "replace", { overwrite: false }), { code: "ENVIRONMENT_PATH_EXISTS" });
    await symlink(f.outside, join(f.workspace, "external"), "junction");
    await symlink(process.env.SystemRoot, join(f.workspace, "system"), "junction");
    await assert.rejects(environment.readFile("external/sentinel.txt"), { code: "ENVIRONMENT_INVALID_PATH" });
    await assert.rejects(environment.listDirectory("system"), { code: "ENVIRONMENT_INVALID_PATH" });
    const listing = await environment.listDirectory(".", { recursive: true });
    assert.ok(listing.entries.some((entry) => entry.path === "system" && entry.type === "symlink"));
    assert.ok(!listing.entries.some((entry) => entry.path.startsWith("system/")));
    assert.equal((await environment.listDirectory(".", { maxEntries: 1 })).entries.length, 1);
    const denied = await environment.runProcess({ command: "node", args: ["-e", "require('node:fs').writeFileSync(process.argv[1],'changed')", f.sentinel] });
    assert.notEqual(denied.exitCode, 0);
    const deniedRead = await environment.runProcess({ command: "node", args: ["-e", "require('node:fs').readFileSync(process.argv[1])", f.sentinel] });
    assert.notEqual(deniedRead.exitCode, 0);
    assert.equal(await readFile(f.sentinel, "utf8"), "protected");
    const probe = await environment.runProcess({ command: "node", args: ["-e", "process.stdout.write(process.execPath)"] });
    const runtime = dirname(probe.stdout);
    const state = dirname(runtime);
    for (const target of [join(runtime, "launch.cjs"), join(state, "private", "agent-policy.json")]) {
      const result = await environment.runProcess({ command: "node", args: ["-e", "require('node:fs').writeFileSync(process.argv[1],'changed')", target] });
      assert.notEqual(result.exitCode, 0);
    }
    const privateRead = await environment.runProcess({ command: "node", args: ["-e", "require('node:fs').readFileSync(process.argv[1])", join(state, "private", "agent-policy.json")] });
    assert.notEqual(privateRead.exitCode, 0);
    const binary = Uint8Array.from({ length: 256 }, (_, index) => index);
    await environment.writeFile("artifact.bin", binary);
    const reference = createArtifactReference(environment.environmentId, "artifact.bin");
    const destination = join(f.outside, "export.bin");
    await environment.exportArtifact(reference, destination);
    assert.deepEqual(await readFile(destination), Buffer.from(binary));
    await assert.rejects(environment.exportArtifact(reference, destination), { code: "ENVIRONMENT_EXPORT_DESTINATION_EXISTS" });
    await assert.rejects(environment.readArtifact({ ...reference, environmentId: "different" }), { code: "ENVIRONMENT_ARTIFACT_MISMATCH" });
    const result = await environment.runProcess({ command: "node", args: ["-e", "process.stdin.pipe(process.stdout); process.stderr.write('error'); process.exitCode=42"], input: "input" });
    assert.equal(result.stdout, "input");
    assert.equal(result.stderr, "error");
    assert.equal(result.exitCode, 42);
    const output = await environment.runProcess({ command: "node", args: ["-e", "process.stdout.write('x'.repeat(10000))"] }, { maxOutputBytes: 128 });
    assert.equal(output.stdoutData.length, 128);
    assert.equal(output.stdoutBytes, 10000);
    assert.equal(output.stdoutTruncated, true);
    const reports = await Promise.all([environment.close(), environment.close()]);
    assert.deepEqual(reports[0], reports[1]);
    await assert.rejects(environment.readFile("artifact.bin"), { code: "ENVIRONMENT_CLOSED" });
    assert.equal(await readFile(f.sentinel, "utf8"), "protected");
    assert.deepEqual(await readFile(destination), Buffer.from(binary));
  } finally {
    await environment.close();
    await rm(f.root, { recursive: true });
  }
});

test("hard links are refused before granting permissions and after creation", windows, async () => {
  const f = await fixture();
  const linked = join(f.workspace, "linked.txt");
  await link(f.sentinel, linked);
  await assert.rejects(createLandstripEnvironment({ workspace: f.workspace }), { code: "ENVIRONMENT_PATH_UNSUPPORTED" });
  assert.equal(await readFile(f.sentinel, "utf8"), "protected");
  await rm(linked);
  const environment = await createLandstripEnvironment({ workspace: f.workspace });
  try {
    await link(f.sentinel, linked);
    await assert.rejects(environment.runProcess({ command: "cmd.exe", args: ["/c", "echo changed>linked.txt"] }), { code: "ENVIRONMENT_PATH_UNSUPPORTED" });
    await assert.rejects(environment.readFile("linked.txt"), { code: "ENVIRONMENT_PATH_UNSUPPORTED" });
    assert.equal(await readFile(f.sentinel, "utf8"), "protected");
  } finally {
    await environment.close();
    await rm(f.root, { recursive: true });
  }
});

test("default network policy refuses connections to an actual listening service", windows, async () => {
  const f = await fixture();
  let connections = 0;
  const server = createServer((socket) => { connections += 1; socket.end(); });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const environment = await createLandstripEnvironment({ workspace: f.workspace });
  try {
    const port = server.address().port;
    const result = await environment.runProcess({
      command: "node",
      args: ["-e", "const socket=require('node:net').connect({host:'127.0.0.1',port:Number(process.argv[1])});socket.on('connect',()=>{process.stdout.write('connected');process.exit(0)});socket.on('error',error=>{process.stderr.write(error.code);process.exit(5)})", String(port)],
      timeoutMs: 10000,
    });
    assert.notEqual(result.exitCode, 0);
    assert.equal(connections, 0);
  } finally {
    await environment.close();
    await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    await rm(f.root, { recursive: true });
  }
});

test("a workspace executable cannot expand the policy through NTFS streams", windows, async () => {
  const f = await fixture();
  const executable = join(f.workspace, "command.exe");
  await copyFile(process.execPath, executable);
  await writeFile(`${executable}:landstrip.policy`, JSON.stringify({ filesystem: { allowWrite: [f.outside], allowRead: [f.outside] }, network: { allowNetwork: true } }));
  const environment = await createLandstripEnvironment({ workspace: f.workspace });
  try {
    const allowed = await environment.runProcess({ command: executable, args: ["-e", "process.stdout.write('ready')"] });
    assert.equal(allowed.exitCode, 0);
    assert.equal(allowed.stdout, "ready");
    const result = await environment.runProcess({ command: executable, args: ["-e", "require('node:fs').writeFileSync(process.argv[1],'changed')", f.sentinel] });
    assert.notEqual(result.exitCode, 0);
    assert.equal(await readFile(f.sentinel, "utf8"), "protected");
  } finally {
    await environment.close();
    await rm(f.root, { recursive: true });
  }
});

test("independent environments cannot write each other's workspace", windows, async () => {
  const left = await fixture();
  const right = await fixture();
  const first = await createLandstripEnvironment({ workspace: left.workspace });
  const second = await createLandstripEnvironment({ workspace: right.workspace });
  try {
    await first.writeFile("own.txt", "left");
    await second.writeFile("own.txt", "right");
    const results = await Promise.all([
      first.runProcess({ command: "node", args: ["-e", "require('node:fs').writeFileSync(process.argv[1],'changed')", join(right.workspace, "own.txt")] }),
      second.runProcess({ command: "node", args: ["-e", "require('node:fs').writeFileSync(process.argv[1],'changed')", join(left.workspace, "own.txt")] }),
    ]);
    assert.ok(results.every((result) => result.exitCode !== 0));
    assert.equal(await readFile(join(left.workspace, "own.txt"), "utf8"), "left");
    assert.equal(await readFile(join(right.workspace, "own.txt"), "utf8"), "right");
  } finally {
    await first.close();
    await second.close();
    await rm(left.root, { recursive: true });
    await rm(right.root, { recursive: true });
  }
});

test("timeout and cancellation stop actual descendants", windows, async () => {
  const f = await fixture();
  const environment = await createLandstripEnvironment({ workspace: f.workspace });
  const childSource = "require('node:fs').writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000)";
  const parentSource = "const{spawn}=require('node:child_process');spawn(process.execPath,['child.cjs',process.argv[2]],{stdio:'inherit'});setInterval(()=>{},1000)";
  const isRunning = (pid) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
  };
  try {
    await environment.writeFile("child.cjs", childSource);
    await environment.writeFile("parent.cjs", parentSource);
    await assert.rejects(environment.runProcess({ command: "node", args: ["parent.cjs", "timeout.pid"], timeoutMs: 6000 }), { code: "ENVIRONMENT_PROCESS_TIMEOUT" });
    assert.equal(isRunning(Number(await readFile(join(f.workspace, "timeout.pid"), "utf8"))), false);
    const running = await environment.startProcess({ command: "node", args: ["parent.cjs", "cancel.pid"] });
    const deadline = Date.now() + 10000;
    let pid;
    while (pid === undefined && Date.now() < deadline) {
      try { pid = Number(await readFile(join(f.workspace, "cancel.pid"), "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (pid === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(pid > 0);
    assert.equal((await running.cancel()).confirmed, true);
    await assert.rejects(running.result, { code: "ENVIRONMENT_PROCESS_CANCELLED" });
    assert.equal(isRunning(pid), false);
  } finally {
    await environment.close();
    await rm(f.root, { recursive: true });
  }
});

test("limits, pre-abort and close during execution enforce the public lifecycle", windows, async () => {
  const f = await fixture();
  const environment = await createLandstripEnvironment({ workspace: f.workspace, limits: { maxConcurrentProcesses: 1, maxFileBytes: 1 } });
  try {
    const signal = AbortSignal.abort(new Error("cancelled before start"));
    await assert.rejects(environment.writeFile("cancelled.txt", "x", { signal }));
    await assert.rejects(readFile(join(f.workspace, "cancelled.txt")), { code: "ENOENT" });
    await environment.writeFile("one.bin", new Uint8Array([255]));
    assert.deepEqual((await environment.readFile("one.bin")).bytes, Buffer.from([255]));
    await assert.rejects(environment.writeFile("too-large.bin", new Uint8Array([0, 1])), { code: "ENVIRONMENT_OUTPUT_TOO_LARGE" });
    await assert.rejects(environment.runProcess({ command: "node", timeoutMs: 0 }), { code: "ENVIRONMENT_INVALID_OPTION" });
    const running = await environment.startProcess({ command: "node", args: ["-e", "process.stdout.write('ready'); setInterval(()=>{},1000)"] });
    await assert.rejects(environment.startProcess({ command: "node", args: ["--version"] }), { code: "ENVIRONMENT_PROCESS_LIMIT_REACHED" });
    await assert.rejects(environment.statFile("one.bin"), { code: "ENVIRONMENT_PROCESS_LIMIT_REACHED" });
    const report = await environment.close();
    assert.equal(report.stoppedProcesses, 1);
    assert.deepEqual(report.unconfirmedProcessIds, []);
    await assert.rejects(running.result, { code: "ENVIRONMENT_PROCESS_CANCELLED" });
    assert.equal((await environment.status()).activeProcesses, 0);
  } finally {
    await environment.close();
    await rm(f.root, { recursive: true });
  }
});
