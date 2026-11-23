import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { access, chmod, lstat, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { updateDefaultMayModel } from "@sortedyuan/may/config";
import { acquireFileLock, withFileAccess } from "@sortedyuan/may/storage";
import { closeServer, createTestDirectory, trackServer } from "@sortedyuan/test-support";
import {
  PostRenameDurabilityError,
  resolveConfigTargetPath,
  writeDurableIfUnchanged,
} from "../dist/config-file-write.js";
import { AgentGateway } from "../dist/gateway.js";
import { withGatewayConfiguration } from "../dist/gateway-config.js";
import { gatewaySettings } from "../dist/gateway-settings.js";
import { inspectGatewaySetup, startGatewaySetup } from "../dist/gateway-setup.js";
import { actorKey } from "../dist/gateway-types.js";

const skipPosixDirectorySync = process.platform === "win32" || process.getuid?.() === 0;

async function writeFailingCloseAdapter(adapterModulePath) {
  await writeFile(
    adapterModulePath,
    [
      "export function createAdapter() {",
      "  return {",
      "    capabilities: { cancel: false, steer: false, resume: false, delete: true, approvals: false, collaboration: false, media: [] },",
      '    async createConversation() { return "conv-1"; },',
      '    async execute() { return { text: "ok" }; },',
      '    async inspect() { return { status: "idle" }; },',
      "    async deleteConversation() {},",
      '    async close() { throw new Error("adapter close exploded"); },',
      "  };",
      "}",
    ].join("\n"),
    "utf8",
  );
}

test("writeDurableIfUnchanged verifies target immediately before rename after temp file is written and synced", async (t) => {
  const dir = await createTestDirectory(t, "maybeclaw/config-cas");
  const target = join(dir, "config.json");
  await writeFile(target, '{"version":1}\n', "utf8");

  let sawSyncedTempFile = false;
  await assert.rejects(
    writeDurableIfUnchanged(target, '{"version":2}\n', async () => {
      const entries = await readdir(dir);
      const pending = entries.find((name) => name.startsWith(".config.json.") && name.endsWith(".pending"));
      assert.ok(pending, "expected temp file to exist on disk before verifyUnchanged runs");
      assert.equal(await readFile(join(dir, pending), "utf8"), '{"version":2}\n');
      sawSyncedTempFile = true;
      await writeFile(target, '{"version":"external"}\n', "utf8");
      throw new Error("conflict detected");
    }),
    /conflict detected/,
  );

  assert.equal(sawSyncedTempFile, true);
  assert.equal(await readFile(target, "utf8"), '{"version":"external"}\n');
  const remaining = (await readdir(dir)).filter((name) => name.endsWith(".pending"));
  assert.deepEqual(remaining, [], "aborted write must clean up pending temporary file");
});

test("Gateway and updateDefaultMayModel share the exact same canonical lock and preserve concurrent edits across symlinks", async (t) => {
  const dir = await createTestDirectory(t, "maybeclaw/config-symlink");
  const realDir = join(dir, "real");
  const aliasDir = join(dir, "alias-dir");
  await mkdir(realDir, { recursive: true });
  const realPath = join(realDir, "config.json");
  const initial = {
    providers: { local: { adapter: "custom-test-adapter" } },
    models: {
      first: { provider: "local", model: "first" },
      second: { provider: "local", model: "second" },
      third: { provider: "local", model: "third" },
    },
    defaultModel: "first",
    apps: { maybeclaw: { version: 2, agents: [] } },
  };
  await writeFile(realPath, JSON.stringify(initial, null, 2) + "\n", "utf8");
  const canonical = await realpath(realPath);

  async function verifySharedLockAndConcurrentUpdates(accessPath, expectedModel, expectedMaxConcurrent) {
    assert.equal(await resolveConfigTargetPath(accessPath), canonical);

    await withFileAccess(canonical, "exclusive", async () => {
      await assert.rejects(
        withGatewayConfiguration(accessPath, async () => {}),
        { code: "FILE_ACCESS_REENTRANT" },
      );
      await assert.rejects(updateDefaultMayModel(accessPath, expectedModel), { code: "FILE_ACCESS_REENTRANT" });
    });

    await Promise.all([
      withGatewayConfiguration(accessPath, async (raw, save) => {
        raw.server = { maxConcurrent: expectedMaxConcurrent };
        await save();
      }),
      updateDefaultMayModel(accessPath, expectedModel),
    ]);

    const saved = JSON.parse(await readFile(realPath, "utf8"));
    assert.equal(saved.defaultModel, expectedModel);
    assert.equal(saved.apps.maybeclaw.server.maxConcurrent, expectedMaxConcurrent);
  }

  await symlink(realDir, aliasDir, process.platform === "win32" ? "junction" : "dir");
  await verifySharedLockAndConcurrentUpdates(join(aliasDir, "config.json"), "second", 4);

  const linkDir = join(dir, "link-dir");
  await mkdir(linkDir, { recursive: true });
  const fileLink = join(linkDir, "linked-config.json");
  let fileSymlinkSupported = true;
  try {
    await symlink(realPath, fileLink, "file");
  } catch (error) {
    if (error && (error.code === "EPERM" || error.code === "EACCES")) {
      fileSymlinkSupported = false;
    } else {
      throw error;
    }
  }
  if (fileSymlinkSupported) {
    await verifySharedLockAndConcurrentUpdates(fileLink, "third", 6);
    assert.equal((await lstat(fileLink)).isSymbolicLink(), true, "saving through file symlink must preserve symlink");

    if (!skipPosixDirectorySync) {
      // Making only realDir wx-only (0o300) while linkDir stays 0o700 proves via real kernel EACCES
      // that directory synchronization targets realDir rather than linkDir.
      await chmod(realDir, 0o300);
      try {
        await assert.rejects(
          withGatewayConfiguration(fileLink, async (raw, save) => {
            raw.server = { maxConcurrent: 8 };
            await save();
          }),
          (error) => error instanceof PostRenameDurabilityError && error.cause?.code === "EACCES",
        );
      } finally {
        await chmod(realDir, 0o700);
      }
    }
  }
});

test("concurrent duplicate POST during setup activation receives 403 without aborting the active setup request", async (t) => {
  const dir = await createTestDirectory(t, "maybeclaw/setup-concurrent-dup");
  const configPath = join(dir, "config.json");
  const enteredActivate = Promise.withResolvers();
  const releaseActivate = Promise.withResolvers();
  let completedSettled = false;
  let transferredServer;

  const setup = await startGatewaySetup({
    path: configPath,
    port: 0,
    activate: async (listener) => {
      transferredServer = trackServer(t, listener);
      enteredActivate.resolve();
      await releaseActivate.promise;
    },
  });
  const cliLifecycle = (async () => {
    try {
      await setup.completed;
      completedSettled = true;
      return undefined;
    } catch (error) {
      completedSettled = true;
      return error;
    } finally {
      await setup.close();
    }
  })();

  const url = new URL(setup.url);
  const token = new URLSearchParams(url.hash.slice(1)).get("initialize");
  const password = randomBytes(8).toString("hex");

  try {
    const firstRequest = fetch(`${url.origin}/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ password, confirmation: password }),
    });

    await enteredActivate.promise;

    const duplicateResponse = await fetch(`${url.origin}/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ password, confirmation: password }),
    });
    assert.equal(duplicateResponse.status, 403);
    assert.equal(completedSettled, false, "duplicate 403 request must NOT settle setup.completed");

    releaseActivate.resolve();
    const firstResponse = await firstRequest;
    assert.equal(firstResponse.status, 200);
    assert.deepEqual(await firstResponse.json(), { initialized: true });
    assert.equal(await cliLifecycle, undefined);
  } finally {
    releaseActivate.resolve();
    await setup.close();
    await closeServer(transferredServer);
  }
});

test("real AgentGateway evicts loaded adapter when adapter.close() fails and still shuts down cleanly", async (t) => {
  const dir = await createTestDirectory(t, "maybeclaw/gateway-close-fail");
  const configPath = join(dir, "config.json");
  const adapterModulePath = join(dir, "failing-close-adapter.mjs");
  await writeFailingCloseAdapter(adapterModulePath);

  const operator = { kind: "operator", id: "service-admin" };
  const flakyAgent = { id: "flaky", adapter: "module", module: adapterModulePath };
  const rawConfig = {
    providers: {},
    apps: { maybeclaw: { version: 2, agents: [{ id: "code", adapter: "may" }, flakyAgent] } },
  };
  await writeFile(configPath, JSON.stringify(rawConfig, null, 2) + "\n", "utf8");
  const gateway = new AgentGateway({ directory: join(dir, "state"), configPath, settings: gatewaySettings(rawConfig) });
  let testFailed = false;
  try {
    const flakySession = gateway.createSession(operator, "适配器会话", ["flaky"]);
    await gateway.handle("/agent create flaky", operator, { requestId: "load-flaky-win", sessionId: flakySession.id });
    await gateway.manageSession(flakySession, operator, "delete", true);
    assert.equal(gateway.status().agents.find((agent) => agent.id === "flaky")?.status, "loaded");

    await assert.rejects(gateway.updateAgent("flaky", operator, null), /adapter close exploded/);
    assert.equal(
      gateway.status().agents.some((agent) => agent.id === "flaky"),
      false,
    );
    assert.throws(() => gateway.createSession(operator, "已删除", ["flaky"]), /Agent flaky 不可用/);
  } catch (error) {
    testFailed = true;
    throw error;
  } finally {
    if (testFailed) await gateway.close().catch(() => {});
    else await gateway.close();
  }
});

test(
  "startGatewaySetup returns HTTP 500 and preserves PostRenameDurabilityError on real POSIX sync EACCES, even when launch cleanup also fails",
  { skip: skipPosixDirectorySync },
  async (t) => {
    for (const breakLaunchCleanup of [false, true]) {
      const dir = await createTestDirectory(
        t,
        `maybeclaw/setup-posix-eacces-${breakLaunchCleanup ? "cleanup-fail" : "clean"}`,
      );
      const cfgDir = join(dir, "cfg");
      await mkdir(cfgDir, { recursive: true });
      const configPath = join(cfgDir, "config.json");
      let activated = false;
      const setup = await startGatewaySetup({
        path: configPath,
        port: 0,
        activate: async () => {
          activated = true;
        },
      });

      const cliLifecycle = (async () => {
        try {
          await setup.completed;
          return undefined;
        } catch (error) {
          return error;
        } finally {
          await setup.close();
        }
      })();

      const url = new URL(setup.url);
      const token = new URLSearchParams(url.hash.slice(1)).get("initialize");
      const password = randomBytes(8).toString("hex");

      try {
        if (breakLaunchCleanup) {
          // Replacing launchPath with a directory makes real rm(launchPath, { force: true }) fail with EISDIR/EPERM.
          await rm(setup.launchPath, { force: true });
          await mkdir(setup.launchPath);
        }
        await chmod(cfgDir, 0o300);

        const response = await fetch(`${url.origin}/api/setup`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ password, confirmation: password }),
        });
        assert.equal(response.status, 500);
        const payload = await response.json();
        assert.match(payload.error, /目录同步失败/);

        const completionError = await cliLifecycle;
        if (breakLaunchCleanup) {
          assert.ok(completionError instanceof AggregateError);
          assert.equal(completionError.errors.length, 2);
          assert.ok(completionError.errors[0] instanceof PostRenameDurabilityError);
          assert.equal(completionError.errors[0].cause?.code, "EACCES");
          assert.ok(completionError.errors[1] instanceof Error);
        } else {
          assert.ok(completionError instanceof PostRenameDurabilityError);
          assert.equal(completionError.cause?.code, "EACCES");
          await assert.rejects(access(setup.launchPath), { code: "ENOENT" });
        }
        assert.equal(activated, false);
        assert.equal((await inspectGatewaySetup(configPath)).needsSetup, false);

        const lock = await acquireFileLock(`${await resolveConfigTargetPath(configPath)}.initialize.lock`);
        await lock.release();
      } finally {
        await chmod(cfgDir, 0o700);
        await setup.close();
      }
    }
  },
);

test(
  "real AgentGateway syncs sessionAdmins and evicts loaded adapter on real POSIX directory sync EACCES plus adapter close failure",
  { skip: skipPosixDirectorySync },
  async (t) => {
    const dir = await createTestDirectory(t, "maybeclaw/gateway-posix-sync-fail");
    const cfgDir = join(dir, "cfg");
    await mkdir(cfgDir, { recursive: true });
    const configPath = join(cfgDir, "config.json");
    const adapterModulePath = join(dir, "failing-close-adapter.mjs");
    await writeFailingCloseAdapter(adapterModulePath);

    const operator = { kind: "operator", id: "service-admin" };
    const entry = { account: "telegram:42", conversation: "-100", kind: "group" };
    const revokedAdmin = { kind: "platform", account: entry.account, conversation: entry.conversation, userId: "456" };
    const flakyAgent = { id: "flaky", adapter: "module", module: adapterModulePath };
    const rawConfig = {
      providers: {},
      apps: { maybeclaw: { version: 2, agents: [{ id: "code", adapter: "may" }, flakyAgent] } },
    };
    await writeFile(configPath, JSON.stringify(rawConfig, null, 2) + "\n", { mode: 0o600 });
    const gateway = new AgentGateway({
      directory: join(dir, "state"),
      configPath,
      settings: gatewaySettings(rawConfig),
    });
    let testFailed = false;
    try {
      const adminSession = gateway.createSession(operator, "群聊", ["code"], [], entry);
      await gateway.setSessionAdmins(adminSession.id, operator, [actorKey(revokedAdmin)]);
      assert.equal(gateway.isAdmin(adminSession, revokedAdmin), true);

      const flakySession = gateway.createSession(operator, "适配器会话", ["flaky"]);
      await gateway.handle("/agent create flaky", operator, {
        requestId: "load-flaky-posix",
        sessionId: flakySession.id,
      });
      await gateway.manageSession(flakySession, operator, "delete", true);
      assert.equal(gateway.status().agents.find((agent) => agent.id === "flaky")?.status, "loaded");

      await chmod(cfgDir, 0o300);

      await assert.rejects(
        gateway.setSessionAdmins(adminSession.id, operator, []),
        (error) => error instanceof PostRenameDurabilityError && error.cause?.code === "EACCES",
      );
      assert.equal(gateway.isAdmin(adminSession, revokedAdmin), false);

      await assert.rejects(
        gateway.updateAgent("flaky", operator, null),
        (error) =>
          error instanceof AggregateError &&
          error.errors.length === 2 &&
          error.errors[0] instanceof PostRenameDurabilityError &&
          error.errors[0].cause?.code === "EACCES" &&
          error.errors[1] instanceof Error &&
          /adapter close exploded/.test(error.errors[1].message),
      );
      assert.equal(
        gateway.status().agents.some((agent) => agent.id === "flaky"),
        false,
      );
      assert.throws(() => gateway.createSession(operator, "已删除", ["flaky"]), /Agent flaky 不可用/);
    } catch (error) {
      testFailed = true;
      throw error;
    } finally {
      await chmod(cfgDir, 0o700);
      if (testFailed) await gateway.close().catch(() => {});
      else await gateway.close();
    }
  },
);
