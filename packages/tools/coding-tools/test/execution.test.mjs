import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { openCodingExecutionEnvironment } from "../dist/execution.js";

async function workspace(t) {
  const base = fileURLToPath(new URL("../../../../.test-output/coding-execution", import.meta.url));
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "workspace-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("host environment runs a real process and rejects cwd outside workspace", async (t) => {
  const cwd = await workspace(t);
  const environment = await openCodingExecutionEnvironment({ workspace: cwd, isolation: { mode: "host" } });
  t.after(() => environment.close());
  const child = environment.spawn(process.execPath, ["-e", "process.stdout.write(process.cwd())"], {
    cwd,
    signal: new AbortController().signal,
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  assert.equal((await once(child, "close"))[0], 0);
  assert.equal(output.toLowerCase(), cwd.toLowerCase());
  assert.throws(
    () => environment.spawn(process.execPath, [], { cwd: resolve(cwd, ".."), signal: new AbortController().signal }),
    { code: "CODING_TOOL_PATH_OUTSIDE_WORKSPACE" },
  );
});

test("host pipe exchanges stdin and preserves environment and workspace paths", async (t) => {
  const cwd = await workspace(t);
  const cacheDirectory = join(cwd, "cache with 空格");
  const environment = await openCodingExecutionEnvironment({
    workspace: cwd,
    isolation: { mode: "host" },
    cacheDirectory,
  });
  t.after(() => environment.close());
  assert.equal(environment.cachePath, cacheDirectory);
  const path = join(cwd, "中文 file.ts");
  assert.equal(environment.toEnvironmentPath(path), path);
  assert.equal(environment.toHostPath(path), path);
  assert.equal(environment.toHostPath(resolve(cwd, "..", "outside")), undefined);
  if (process.platform === "win32") {
    assert.equal(environment.toHostPath("\\\\server\\share\\outside.ts"), undefined);
    const otherDrive = cwd[0].toLowerCase() === "z" ? "Y" : "Z";
    assert.equal(environment.toHostPath(`${otherDrive}:\\outside.ts`), undefined);
    assert.equal(environment.toEnvironmentPath(path.toUpperCase()), path.toUpperCase());
  }
  assert.throws(() => environment.toEnvironmentPath(resolve(cwd, "..")), {
    code: "CODING_TOOL_PATH_OUTSIDE_WORKSPACE",
  });
  const child = environment.spawn(
    process.execPath,
    ["-e", "process.stdin.on('data', data => process.stdout.write(process.env.MAY_PIPE_TEST + ':' + data));"],
    {
      cwd,
      signal: new AbortController().signal,
      stdin: "pipe",
      env: { MAY_PIPE_TEST: "通信" },
    },
  );
  child.stdin.write("first");
  assert.equal(String((await once(child.stdout, "data"))[0]), "通信:first");
  child.stdin.end("second");
  assert.equal(String((await once(child.stdout, "data"))[0]), "通信:second");
  assert.equal((await once(child, "close"))[0], 0);
});

test("host pipe cancellation terminates the process and its descendant", { timeout: 15000 }, async (t) => {
  const cwd = await workspace(t);
  const environment = await openCodingExecutionEnvironment({ workspace: cwd, isolation: { mode: "host" } });
  t.after(() => environment.close());
  const controller = new AbortController();
  const child = environment.spawn(
    process.execPath,
    [
      "-e",
      "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)']); child.once('spawn',()=>process.stdout.write(String(child.pid))); setInterval(()=>{},1000);",
    ],
    {
      cwd,
      signal: controller.signal,
      stdin: "pipe",
    },
  );
  const descendant = Number((await once(child.stdout, "data"))[0]);
  const exited = once(child, "close");
  controller.abort();
  await exited;
  await environment.close();
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" });
});

const dockerAvailable =
  spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { windowsHide: true }).status === 0;
const containerImage = process.env.MAY_CODING_TEST_IMAGE;
const containerSkip = !dockerAvailable
  ? "Docker daemon unavailable"
  : containerImage === undefined
    ? "Set MAY_CODING_TEST_IMAGE to an installed image with bash, git, rg, setsid and node"
    : false;

test(
  "container pipe exchanges stdin, maps paths and mounts the cache",
  { skip: containerSkip, timeout: 30000 },
  async (t) => {
    const cwd = await workspace(t);
    const cacheDirectory = join(cwd, "cache");
    const environment = await openCodingExecutionEnvironment({
      workspace: cwd,
      cacheDirectory,
      isolation: {
        mode: "container",
        image: containerImage,
        network: "none",
        memoryBytes: 512 * 1024 * 1024,
        cpuCount: 1,
      },
    });
    t.after(() => environment.close());
    assert.equal(environment.cachePath, "/may-cache");
    const hostPath = join(cwd, "中文 file.ts");
    assert.equal(environment.toEnvironmentPath(hostPath), "/workspace/中文 file.ts");
    assert.equal(environment.toHostPath("/workspace/中文 file.ts"), hostPath);
    assert.equal(environment.toHostPath("/workspace/../outside"), undefined);
    assert.equal(environment.toHostPath("/workspace-other/file.ts"), undefined);
    const child = environment.spawn(
      "node",
      [
        "-e",
        "require('node:fs').writeFileSync(process.env.HOME+'/mounted','yes'); process.stdout.write(JSON.stringify([process.env.XDG_CACHE_HOME,process.env.GOCACHE,process.env.GOFLAGS,process.env.GOPROXY,process.env.CARGO_NET_OFFLINE])); process.stdin.on('data',data=>process.stdout.write(data));",
      ],
      { cwd, stdin: "pipe", signal: new AbortController().signal },
    );
    assert.deepEqual(JSON.parse(String((await once(child.stdout, "data"))[0])), [
      "/may-cache/xdg",
      "/may-cache/go-build",
      "-mod=readonly",
      "off",
      "true",
    ]);
    child.stdin.write("hello");
    assert.equal(String((await once(child.stdout, "data"))[0]), "hello");
    child.stdin.end();
    assert.equal((await once(child, "close"))[0], 0);
    assert.equal(await readFile(join(cacheDirectory, "home", "mounted"), "utf8"), "yes");
    await environment.close();
    assert.deepEqual(await readdir(join(cacheDirectory, "run")), []);
  },
);

for (const immediate of [false, true]) {
  test(
    `container pipe cancellation terminates the process group (immediate=${immediate})`,
    { skip: containerSkip, timeout: 30000 },
    async (t) => {
      const cwd = await workspace(t);
      const environment = await openCodingExecutionEnvironment({
        workspace: cwd,
        cacheDirectory: join(cwd, "cache"),
        isolation: {
          mode: "container",
          image: containerImage,
          network: "none",
          memoryBytes: 512 * 1024 * 1024,
          cpuCount: 1,
        },
      });
      t.after(() => environment.close());
      const controller = new AbortController();
      const child = environment.spawn(
        "node",
        [
          "-e",
          "const {spawn}=require('node:child_process'); spawn('node',['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); process.stdout.write('ready'); setInterval(()=>{},1000);",
        ],
        { cwd, stdin: "pipe", signal: controller.signal },
      );
      const exited = once(child, "close");
      if (!immediate) await once(child.stdout, "data");
      controller.abort();
      await exited;
      await environment.close();
    },
  );
}

test("host cancellation waits for a real running process to exit", async (t) => {
  const cwd = await workspace(t);
  const environment = await openCodingExecutionEnvironment({ workspace: cwd, isolation: { mode: "host" } });
  t.after(() => environment.close());
  const controller = new AbortController();
  const child = environment.spawn(process.execPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"], {
    cwd,
    signal: controller.signal,
  });
  await once(child.stdout, "data");
  const exited = once(child, "close");
  controller.abort();
  await exited;
  await environment.close();
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
});

test("host close terminates running processes and rejects subsequent spawn", async (t) => {
  const cwd = await workspace(t);
  const environment = await openCodingExecutionEnvironment({ workspace: cwd, isolation: { mode: "host" } });
  const child = environment.spawn(process.execPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"], {
    cwd,
    signal: new AbortController().signal,
  });
  await once(child.stdout, "data");
  await environment.close();
  await environment.close();
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  assert.throws(() => environment.spawn(process.execPath, [], { cwd, signal: new AbortController().signal }), {
    code: "CODING_EXECUTION_CLOSED",
  });
});
