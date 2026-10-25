import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rmdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { createBuiltinProviderModel, RetryingModel } from "@sortedyuan/providers";
import { FileSessionStore } from "@sortedyuan/session/file-store";
import { FileSessionCatalog } from "@sortedyuan/session/catalog";
import { MaybeCodeWorkspace, createMaybeCodeWebHost } from "../dist/index.js";

async function openWorkspace(t) {
  const parent = resolve(import.meta.dirname, "../../../review/architecture-fix-20261023");
  await mkdir(parent, { recursive: true });
  const workspace = await mkdtemp(join(parent, "ui-command-"));
  const dataDirectory = join(workspace, "data");
  const model = new RetryingModel(createBuiltinProviderModel({
    profile: "review", provider: "review", adapter: "openai-chat-completions", model: "gpt-4o",
    providerConfig: { adapter: "openai-chat-completions", apiKey: "unused-offline-probe" }, options: {},
    capabilities: { fields: { "input.text": false } },
  }));
  const app = await MaybeCodeWorkspace.open({
    git: false, workspace, model, skills: false, goals: false, subagents: false,
    store: new FileSessionStore(join(dataDirectory, "sessions")),
    catalog: new FileSessionCatalog(join(dataDirectory, "catalog.json")),
  });
  const host = createMaybeCodeWebHost(app);
  t.after(async () => {
    await host.close();
    assert.ok(resolve(workspace).startsWith(parent + sep));
    await rm(workspace, { recursive: true, force: true });
  });
  const command = (name, args = {}, targetId = app.sessionId) => ({
    version: 1, hostId: host.hostId, requestId: crypto.randomUUID(), name, args,
    targetId, expectedActiveId: app.sessionId,
  });
  return { app, host, command, dataDirectory };
}

test("Web commands remain available when another Session journal cannot be read", async t => {
  const { app, host, command, dataDirectory } = await openWorkspace(t);
  const previousId = app.sessionId;
  await app.renameSession(previousId, "Previous session");
  await app.newSession();
  const activeId = app.sessionId;
  assert.equal((await host.snapshot()).selectedId, activeId);
  const journal = join(dataDirectory, "sessions", Buffer.from(previousId).toString("base64url") + ".jsonl");
  await rename(journal, journal + ".saved");
  await mkdir(journal);
  try {
    const unavailable = assert.rejects(host.snapshot(), { code: "EISDIR" });
    await host.execute(command("session.rename", { title: "Current session remains editable" }));
    await unavailable;
    assert.equal((await app.listSessions()).find(session => session.id === activeId).title, "Current session remains editable");
    await assert.rejects(host.execute({ ...command("session.rename", { title: "Untrusted request" }), hostId: "previous-host" }), { status: 409 });
    await host.execute(command("session.new"));
    await assert.rejects(host.execute(command("session.rename", { title: "Stale request" }, activeId)), { status: 409 });
    await assert.rejects(host.execute({ ...command("session.activate", {}, activeId), expectedActiveId: activeId }), { status: 409 });
    assert.notEqual(app.sessionId, activeId);
  } finally {
    await rmdir(journal);
    await rename(journal + ".saved", journal);
  }
  assert.equal((await host.snapshot()).selectedId, app.sessionId);
});

test("Web host shutdown rejects new commands and settles queued commands", async t => {
  const { app, host, command } = await openWorkspace(t);
  const activeId = app.sessionId;
  const queued = host.execute(command("session.new"));
  const rejected = assert.rejects(queued, { status: 503 });
  const closing = host.close();
  assert.equal(host.close(), closing);
  await Promise.all([closing, rejected]);
  await assert.rejects(host.execute(command("session.new")), { status: 503 });
  assert.equal(app.sessionId, activeId);
});
