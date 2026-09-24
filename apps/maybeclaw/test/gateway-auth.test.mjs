import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { verify } from "@node-rs/argon2";
import { AgentGateway } from "../dist/gateway.js";
import { startGatewayServer } from "../dist/gateway-server.js";
import { gatewaySettings } from "../dist/gateway-settings.js";

const base = fileURLToPath(new URL("../../../.zcode/tmp/maybeclaw-auth-tests/", import.meta.url));
async function fixture(t, sessionMs) {
  await mkdir(base, { recursive: true }); const directory = await mkdtemp(join(base, "case-"));
  const password = `  ${randomBytes(24).toString("base64url")}  `;
  const config = { providers: {}, models: {}, apps: { maybeclaw: { version: 2, agents: [{ id: "code", adapter: "may" }], server: { auth: { password, ...(sessionMs ? { sessionMs } : {}) } } } } };
  const path = join(directory, "config.json"); await writeFile(path, JSON.stringify(config));
  const gateway = new AgentGateway({ directory, configPath: path, settings: gatewaySettings(config) });
  const server = await startGatewayServer({ gateway, port: 0 });
  t.after(async () => { await server.close(); assert.ok(resolve(directory).startsWith(resolve(base) + sep)); await rm(directory, { recursive: true, force: true }); });
  const login = (value = password, headers = {}) => fetch(`${server.url}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ password: value }) });
  const get = (token, path = "/api/v2/sessions") => fetch(`${server.url}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const save = async change => { const data = JSON.parse(await readFile(path, "utf8")); change(data.apps.maybeclaw); await writeFile(`${path}.edit`, JSON.stringify(data)); await rename(`${path}.edit`, path); };
  return { password, path, gateway, server, login, get, save };
}
async function credential(login) { const response = await login(); assert.equal(response.status, 200); return (await response.json()).token; }
async function until(predicate) { const deadline = Date.now() + 5000; while (!await predicate()) { assert.ok(Date.now() < deadline, "condition timed out"); await delay(50); } }

test("startup converts plaintext and authenticates exact passwords without exposing secrets", async t => {
  const { password, path, login, get, server } = await fixture(t);
  const text = await readFile(path, "utf8"), auth = JSON.parse(text).apps.maybeclaw.server.auth;
  assert.equal(auth.password, undefined); assert.equal(text.includes(password), false); assert.equal(await verify(auth.passwordHash, password), true);
  assert.equal((await login(password.trim())).status, 401);
  assert.equal((await login(password, { origin: "https://untrusted.example" })).status, 403);
  const token = await credential(login); assert.equal((await get(token)).status, 200);
  assert.equal((await get(auth.passwordHash)).status, 401);
  assert.equal((await get(password)).status, 401);
  const snapshot = await (await get(token, "/api/ui/snapshot")).text();
  assert.equal(snapshot.includes(password), false); assert.equal(snapshot.includes(auth.passwordHash), false);
  const malformed = await fetch(`${server.url}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: `{"password":"${password}` });
  assert.equal(malformed.status, 400); assert.equal((await malformed.text()).includes(password), false);
});

test("saved password is converted without requests, revokes streams and keeps configuration edits", async t => {
  const { path, login, get, save, server } = await fixture(t);
  const token = await credential(login), stream = await get(token, "/api/ui/events");
  assert.equal(stream.status, 200);
  const completed = (async () => { for await (const chunk of stream.body) assert.ok(chunk.length); })();
  const password = randomBytes(32).toString("base64url");
  await save(raw => { raw.server.auth.password = password; raw.agents[0].name = "保存的名称"; });
  await until(async () => !Object.hasOwn(JSON.parse(await readFile(path, "utf8")).apps.maybeclaw.server.auth, "password"));
  await Promise.race([completed, delay(5000).then(() => { throw new Error("SSE did not close"); })]);
  assert.equal((await get(token)).status, 401); assert.equal((await login()).status, 401);
  const next = await credential(() => login(password)); assert.equal((await get(next)).status, 200);
  assert.equal(JSON.parse(await readFile(path, "utf8")).apps.maybeclaw.agents[0].name, "保存的名称");
  const saved = await fetch(`${server.url}/api/v2/agents`, { method: "POST", headers: { authorization: `Bearer ${next}`, "content-type": "application/json" }, body: JSON.stringify({ id: "code", config: { id: "code", adapter: "may", name: "管理器修改" } }) });
  assert.equal(saved.status, 200);
  const raw = JSON.parse(await readFile(path, "utf8")).apps.maybeclaw;
  assert.equal(raw.agents[0].name, "管理器修改"); assert.equal(await verify(raw.server.auth.passwordHash, password), true);
  assert.equal((await get(next)).status, 200);
});

test("logout, expiry, and invalid configuration revoke authentication", async t => {
  const { path, login, get, server } = await fixture(t, 1000);
  const first = await credential(login), second = await credential(login);
  assert.equal((await fetch(`${server.url}/api/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${first}` } })).status, 200);
  assert.equal((await get(first)).status, 401); assert.equal((await get(second)).status, 200);
  await delay(1100); assert.equal((await get(second)).status, 401);
  const third = await credential(login), saved = await readFile(path, "utf8");
  await writeFile(path, "{"); assert.equal((await get(third)).status, 503);
  await writeFile(path, saved); assert.equal((await get(third)).status, 401); assert.equal((await login()).status, 200);
});

test("failed login attempts are bounded and invalid stored hashes fail immediately", async t => {
  const { login, save, get } = await fixture(t);
  for (let index = 0; index < 10; index++) assert.equal((await login(randomBytes(24).toString("hex"))).status, 401);
  assert.equal((await login()).status, 429);
  await save(raw => { raw.server.auth.passwordHash = "invalid"; });
  assert.equal((await get("invalid")).status, 503);
});
