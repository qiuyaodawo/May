import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  InMemoryMcpCredentialStore, KeyringMcpCredentialStore, McpOAuthManager, openMcpClientPool, McpInteractionBroker,
} from "../dist/index.js";
import { startOAuthFixture } from "./fixtures/oauth-server.mjs";

test("OAuth uses PKCE, refreshes, isolates accounts, gates step-up, and revokes on logout", { timeout: 15_000 }, async (t) => {
  const http = await startOAuthFixture(t);
  const store = new InMemoryMcpCredentialStore();
  const oauth = new McpOAuthManager(store);
  const server = { id: "remote", transport: "streamable-http", url: http.url, auth: { type: "oauth", scopes: ["read"] } };
  const optional = await openMcpClientPool({ servers: [{ ...server, required: false }], oauth });
  assert.equal(optional.status()[0].state, "auth-required");
  await optional.close();
  const login = () => oauth.login(server, { onAuthorizationUrl: async (url) => {
    const callback = await http.callback(url);
    const wrong = new URL(callback);
    wrong.searchParams.set("state", "forged");
    assert.equal((await fetch(wrong)).status, 400);
    assert.equal((await fetch(callback)).status, 200);
  } });
  await login();
  assert.equal((await oauth.status(server)).authenticated, true);
  assert.equal((await oauth.status({ ...server, auth: { ...server.auth, account: "other" } })).authenticated, false);
  const broker = new McpInteractionBroker();
  const pool = await openMcpClientPool({ servers: [server], oauth, interactions: broker });
  t.after(() => pool.close());
  const execute = () => pool.tools[0].execute({}, {
    scope: { workspaceId: "workspace", sessionId: "session" }, signal: new AbortController().signal, runId: "run", step: 1, toolCallId: "call", idempotencyKey: "run:call", report() {},
  });
  http.invalidateAccess();
  assert.equal((await execute()).content[0].text, "authorized");
  assert.equal(http.counts.refreshes, 1);
  http.demandWrite();
  const before = http.counts.toolCalls;
  await assert.rejects(execute(), (error) => error.code === "MCP_AUTHENTICATION_REQUIRED");
  assert.equal(http.counts.toolCalls, before + 1, "denied tools are not replayed for consent");
  assert.equal((await oauth.status(server)).requiresConsent, true);
  assert.equal(pool.status()[0].state, "auth-required");
  await login();
  await pool.reconnect("remote");
  assert.equal((await execute()).content[0].text, "authorized");
  assert.equal(pool.status()[0].state, "connected");
  http.rotateIssuer();
  await assert.rejects(execute(), (error) => error.code === "MCP_AUTHENTICATION_REQUIRED");
  assert.equal(http.counts.refreshes, 1, "never redeem the old refresh token with a new issuer");
  await login();
  await pool.reconnect("remote");
  assert.equal((await execute()).content[0].text, "authorized");
  await pool.readResource("remote", "private:///data");
  assert.equal((await pool.readResource("remote", "private:///data")).fromCache, true);
  await login();
  await assert.rejects(pool.readResource("remote", "private:///data"), (error) => error.code === "MCP_CAPABILITY_ERROR");
  await pool.reconnect("remote");
  assert.equal((await pool.readResource("remote", "private:///data")).fromCache, false);
  http.setToolInput(() => ({ resultType: "input_required", requestState: "old-principal", inputRequests: {
    form: { method: "elicitation/create", params: { mode: "form", message: "Confirm", requestedSchema: { type: "object", properties: {} } } },
  } }));
  const waiting = execute(); void waiting.catch(() => {});
  const question = (await broker.events[Symbol.asyncIterator]().next()).value.request;
  const callsBeforeLogin = http.counts.toolCalls;
  await login();
  broker.respond(question.id, question.owner, { action: "accept", content: {} });
  await assert.rejects(waiting, /identity changed/);
  assert.equal(http.counts.toolCalls, callsBeforeLogin, "never continue old requestState under a new authorization principal");
  http.setToolInput(undefined);
  await pool.reconnect("remote");
  assert.deepEqual(await oauth.logout(server), { revoked: true });
  await assert.rejects(pool.readResource("remote", "private:///data"), (error) => error.code === "MCP_AUTHENTICATION_REQUIRED");
  assert.equal(http.counts.revocations, 2);
  assert.equal((await oauth.status(server)).authenticated, false);
});

test("OAuth rejects issuer mix-ups before code exchange and cancels its callback listener", { timeout: 10_000 }, async (t) => {
  const http = await startOAuthFixture(t);
  const oauth = new McpOAuthManager(new InMemoryMcpCredentialStore());
  const server = { id: "remote", transport: "streamable-http", url: http.url, auth: { type: "oauth" } };
  await assert.rejects(oauth.login(server, { onAuthorizationUrl: async (url) => {
    const callback = await http.callback(url);
    callback.searchParams.set("iss", `${http.origin}/different-issuer`);
    await fetch(callback);
  } }), (error) => error.code === "MCP_AUTHENTICATION_FAILED" && !error.message.includes("different-issuer"));
  assert.equal(http.counts.exchanges, 0);
  let callbackUrl;
  const abort = new AbortController();
  const reason = new Error("cancel login");
  await assert.rejects(oauth.login(server, { signal: abort.signal, onAuthorizationUrl: (url) => {
    callbackUrl = url.searchParams.get("redirect_uri");
    abort.abort(reason);
  } }), (error) => error === reason);
  await assert.rejects(fetch(callbackUrl));
  const registrations = http.counts.registrations;
  for (const registration of [
    { clientId: "may-public", expectedIssuer: http.origin },
    { clientMetadataUrl: "https://client.example/metadata.json" },
  ]) {
    const configured = { ...server, auth: { type: "oauth", ...registration } };
    await oauth.login(configured, { onAuthorizationUrl: async (url) => {
      await fetch(await http.callback(url));
    } });
    assert.equal((await oauth.status(configured)).authenticated, true);
    assert.deepEqual(await oauth.logout(configured), { revoked: true });
  }
  assert.equal(http.counts.registrations, registrations, "public registration and CIMD do not use DCR");
});

test("credential vault encrypts large grants, detects tampering, and serializes writers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "may-mcp-vault-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let secret;
  const keyring = process.env.MAY_TEST_OS_KEYRING === "1"
    ? new (await import("@napi-rs/keyring")).AsyncEntry("may.mcp.test", randomUUID())
    : { getPassword: async () => secret, setPassword: async (value) => { secret = value; } };
  if ("deleteCredential" in keyring) t.after(() => keyring.deleteCredential());
  const store = new KeyringMcpCredentialStore(directory, keyring);
  const value = { refresh_token: `secret-${"x".repeat(8_000)}`, issuer: "https://issuer.test" };
  await store.set("grant", value);
  assert.deepEqual(await new KeyringMcpCredentialStore(directory, keyring).get("grant"), value);
  const path = join(directory, (await readdir(directory)).find((name) => name.endsWith(".json")));
  const bytes = await readFile(path, "utf8");
  assert.doesNotMatch(bytes, /secret-|issuer\.test/u);
  const order = [];
  await Promise.all([1, 2].map((n) => store.exclusive("refresh", async () => { order.push(n); await new Promise((r) => setTimeout(r, 10)); order.push(n); })));
  assert.ok(JSON.stringify(order) === "[1,1,2,2]" || JSON.stringify(order) === "[2,2,1,1]");
  const tampered = JSON.parse(bytes);
  tampered.tag = Buffer.alloc(16).toString("base64");
  await writeFile(path, JSON.stringify(tampered));
  await assert.rejects(store.get("grant"), (error) => error.code === "MCP_CREDENTIAL_STORE_UNAVAILABLE");
  await store.delete("grant");
  assert.equal(await store.get("grant"), undefined);
});
