import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runMaybeClaw } from "../dist/run.js";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const base = fileURLToPath(new URL("../../../.zcode/tmp/maybeclaw-launch-tests/", import.meta.url));
async function fixture(t) {
  await mkdir(base, { recursive: true }); const directory = await mkdtemp(join(base, "case-"));
  t.after(async () => { assert.ok(resolve(directory).startsWith(resolve(base) + sep)); await rm(directory, { recursive: true, force: true }); });
  return directory;
}

test("bare CLI loads the default configuration and help remains explicit", async t => {
  const directory = await fixture(t), env = { ...process.env, HOME: directory, USERPROFILE: directory };
  await mkdir(join(directory, ".may"));
  await writeFile(join(directory, ".may", "config.json"), JSON.stringify({ providers: {}, apps: { maybeclaw: { version: 1 } } }));
  await assert.rejects(execute(process.execPath, [cli], { env, timeout: 10000 }), error => {
    assert.equal(error.code, 1); assert.equal(error.stdout, "");
    assert.match(error.stderr, /旧版 MaybeClaw 配置/); return true;
  });
  for (const help of ["--help", "-h"]) {
    const result = await execute(process.execPath, [cli, help], { env });
    assert.match(result.stdout, /start the Web console/); assert.equal(result.stderr, "");
  }
  for (const args of [["--unknown"], ["--no-open", "--no-open"], ["--port", "invalid"], ["session", "list", "--no-open"]]) {
    await assert.rejects(execute(process.execPath, [cli, ...args], { env }), error => error.code === 2);
  }
});

for (const prefix of [[], ["serve"]]) test(`${prefix[0] ?? "default"} launch serves authenticated Web and closes cleanly`, { timeout: 15_000 }, async t => {
  const directory = await fixture(t), path = join(directory, "config.json"), password = randomBytes(32).toString("base64url");
  await writeFile(path, JSON.stringify({ providers: {}, models: {}, apps: { maybeclaw: {
    version: 2, agents: [{ id: "code", adapter: "may" }], server: { auth: { password } },
  } } }));
  const stdout = new PassThrough(), stderr = new PassThrough(), controller = new AbortController();
  let errors = ""; stderr.on("data", chunk => { errors += chunk.toString(); });
  const ready = once(stdout, "data", { signal: AbortSignal.timeout(10_000) });
  const work = runMaybeClaw([...prefix, ...(prefix.length ? [] : ["--no-open"]), "--config", path, "--data-directory", join(directory, "state"), "--port", "0"], { stdout, stderr, signal: controller.signal });
  t.after(async () => { controller.abort(); await work; stdout.destroy(); stderr.destroy(); });
  const startup = JSON.parse((await Promise.race([ready, work.then(code => { throw new Error(`Service exited early: ${code}; ${errors}`); })]))[0].toString());
  assert.match(startup.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await fetch(startup.url)).status, 200);
  assert.equal((await fetch(`${startup.url}/api/v2/sessions`)).status, 401);
  const login = await fetch(`${startup.url}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200); const { token } = await login.json();
  const sessions = await fetch(`${startup.url}/api/v2/sessions`, { headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual(await sessions.json(), []);
  assert.equal(JSON.parse(await readFile(path, "utf8")).apps.maybeclaw.server.auth.password, undefined);
  controller.abort(); assert.equal(await work, 0); assert.equal(errors, "");
  await assert.rejects(fetch(startup.url));
});

test("launch accepts empty agents array and omitted agents, rejects invalid agents types", { timeout: 25_000 }, async t => {
  const directory = await fixture(t), password = randomBytes(32).toString("base64url");

  const emptyPath = join(directory, "empty-agents.json");
  await writeFile(emptyPath, JSON.stringify({ providers: {}, models: {}, apps: { maybeclaw: {
    version: 2, agents: [], server: { auth: { password } },
  } } }));
  const stdoutEmpty = new PassThrough(), stderrEmpty = new PassThrough(), controllerEmpty = new AbortController();
  let workEmpty;
  try {
    const readyEmpty = once(stdoutEmpty, "data", { signal: AbortSignal.timeout(10_000) });
    workEmpty = runMaybeClaw(["--no-open", "--config", emptyPath, "--data-directory", join(directory, "state-empty"), "--port", "0"], { stdout: stdoutEmpty, stderr: stderrEmpty, signal: controllerEmpty.signal });
    const startupEmpty = JSON.parse((await Promise.race([readyEmpty, workEmpty.then(code => { throw new Error(`Exit ${code}`); })]))[0].toString());
    assert.match(startupEmpty.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const loginEmpty = await fetch(`${startupEmpty.url}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
    assert.equal(loginEmpty.status, 200);
  } finally {
    controllerEmpty.abort();
    if (workEmpty) await workEmpty;
    stdoutEmpty.destroy();
    stderrEmpty.destroy();
  }

  const omittedPath = join(directory, "omitted-agents.json");
  await writeFile(omittedPath, JSON.stringify({ providers: {}, models: {}, apps: { maybeclaw: {
    version: 2, server: { auth: { password } },
  } } }));
  const stdoutOmitted = new PassThrough(), stderrOmitted = new PassThrough(), controllerOmitted = new AbortController();
  let workOmitted;
  try {
    const readyOmitted = once(stdoutOmitted, "data", { signal: AbortSignal.timeout(10_000) });
    workOmitted = runMaybeClaw(["--no-open", "--config", omittedPath, "--data-directory", join(directory, "state-omitted"), "--port", "0"], { stdout: stdoutOmitted, stderr: stderrOmitted, signal: controllerOmitted.signal });
    const startupOmitted = JSON.parse((await Promise.race([readyOmitted, workOmitted.then(code => { throw new Error(`Exit ${code}`); })]))[0].toString());
    assert.match(startupOmitted.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const loginOmitted = await fetch(`${startupOmitted.url}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
    assert.equal(loginOmitted.status, 200);
    const { token: tokenOmitted } = await loginOmitted.json();

    const initialAgentsRes = await fetch(`${startupOmitted.url}/api/v2/agents`, { headers: { authorization: `Bearer ${tokenOmitted}` } });
    assert.equal(initialAgentsRes.status, 200);
    assert.deepEqual(await initialAgentsRes.json(), []);

    const snapshotRes = await fetch(`${startupOmitted.url}/api/ui/snapshot`, { headers: { authorization: `Bearer ${tokenOmitted}` } });
    assert.equal(snapshotRes.status, 200);
    const { hostId } = await snapshotRes.json();

    const addAgentRes = await fetch(`${startupOmitted.url}/api/ui/commands`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenOmitted}`, "content-type": "application/json" },
      body: JSON.stringify({ version: 1, hostId, targetId: null, name: "agent.save", requestId: "add-first-agent", args: { id: "code", config: JSON.stringify({ id: "code", adapter: "may" }) } }),
    });
    assert.equal(addAgentRes.status, 200);

    const updatedAgentsRes = await fetch(`${startupOmitted.url}/api/v2/agents`, { headers: { authorization: `Bearer ${tokenOmitted}` } });
    assert.equal(updatedAgentsRes.status, 200);
    const updatedAgents = await updatedAgentsRes.json();
    assert.equal(updatedAgents.length, 1);
    assert.equal(updatedAgents[0].id, "code");

    const createSessionRes = await fetch(`${startupOmitted.url}/api/ui/commands`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenOmitted}`, "content-type": "application/json" },
      body: JSON.stringify({ version: 1, hostId, targetId: null, name: "session.create", requestId: "create-first-session", args: { name: "会话-省略启动", agents: JSON.stringify(["code"]) } }),
    });
    assert.equal(createSessionRes.status, 200);
    const createSessionData = await createSessionRes.json();
    assert.ok(createSessionData.selectedId);

    const sessionsRes = await fetch(`${startupOmitted.url}/api/v2/sessions`, { headers: { authorization: `Bearer ${tokenOmitted}` } });
    assert.equal(sessionsRes.status, 200);
    const sessions = await sessionsRes.json();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].name, "会话-省略启动");
    assert.deepEqual(sessions[0].defaultAgents, ["code"]);
  } finally {
    controllerOmitted.abort();
    if (workOmitted) await workOmitted;
    stdoutOmitted.destroy();
    stderrOmitted.destroy();
  }

  for (const badAgents of [null, "invalid", {}]) {
    const badPath = join(directory, `bad-agents-${typeof badAgents}.json`);
    await writeFile(badPath, JSON.stringify({ providers: {}, models: {}, apps: { maybeclaw: {
      version: 2, agents: badAgents, server: { auth: { password } },
    } } }));
    const stderrBad = new PassThrough(), controllerBad = new AbortController();
    let err = ""; stderrBad.on("data", c => { err += c.toString(); });
    const code = await runMaybeClaw(["--no-open", "--config", badPath, "--data-directory", join(directory, `state-bad-${typeof badAgents}`), "--port", "0"], { stderr: stderrBad, signal: controllerBad.signal });
    assert.equal(code, 1);
    assert.match(err, /agents 必须为列表/);
    stderrBad.destroy();
  }

});
