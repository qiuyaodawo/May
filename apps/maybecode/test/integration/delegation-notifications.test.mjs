import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMayConfig, resolveModelProfile } from "@sortedyuan/config";
import { openConfiguredMaybeCode } from "../../dist/index.js";
import { executeDelegationCommand } from "../../dist/delegation-commands.js";
import { executeMaybeCodeSlashCommand } from "../../dist/slash-commands.js";

test("配置文件、命令、Session 切换和重新打开工作区保留正确的通知设置", async t => {
  const base = fileURLToPath(new URL("../../../../review/delegation-notifications/", import.meta.url));
  await mkdir(base, { recursive: true });
  const workspace = await mkdtemp(join(base, "settings-"));
  const configPath = join(workspace, "may.json");
  const saved = await loadMayConfig();
  const selected = resolveModelProfile(saved, process.env.MAY_TEST_MODEL);
  assert.ok(selected.providerConfig.apiKey, "The configured provider must have credentials");
  const credentialVariable = "MAY_NOTIFICATION_TEST_PROVIDER_KEY";
  const previousCredential = process.env[credentialVariable];
  process.env[credentialVariable] = selected.providerConfig.apiKey;
  t.after(() => {
    if (previousCredential === undefined) delete process.env[credentialVariable];
    else process.env[credentialVariable] = previousCredential;
  });
  const configuration = {
    providers: { selected: { adapter: selected.adapter, baseURL: selected.providerConfig.baseURL, apiKeyEnv: credentialVariable } },
    models: { chat: { ...saved.models[selected.name], provider: "selected" } },
    defaultModel: "chat",
    apps: { maybecode: {} },
  };
  const options = { workspace, configPath, dataDirectory: join(workspace, "data"), git: false, skills: false, mcp: false, observability: false };
  const applications = [];
  t.after(async () => { for (const app of applications) await app.close(); });
  const open = async extra => {
    const app = await openConfiguredMaybeCode({ ...options, ...extra });
    applications.push(app);
    return app;
  };
  await writeFile(configPath, JSON.stringify(configuration));
  const app = await open();
  assert.equal(app.delegationNotifications, false);
  assert.deepEqual(await executeMaybeCodeSlashCommand("/delegations notifications status", app), { type: "display", text: "Delegation notifications: off" });
  assert.equal(await executeDelegationCommand(["notifications", "on"], app), "Delegation notifications: on");
  await app.newSession();
  assert.equal(app.delegationNotifications, true);
  assert.equal(await executeDelegationCommand(["notifications", "status"], app), "Delegation notifications: on");
  await assert.rejects(executeDelegationCommand(["notifications", "wrong"], app));
  await assert.rejects(executeDelegationCommand(["notifications", "off", "extra"], app));
  assert.throws(() => app.setDelegationNotifications(null), TypeError);
  assert.equal(await readFile(configPath, "utf8"), JSON.stringify(configuration));
  await app.close();
  const reopened = await open();
  assert.equal(reopened.delegationNotifications, false);
  await reopened.close();
  configuration.apps.maybecode.delegationNotifications = true;
  await writeFile(configPath, JSON.stringify(configuration));
  const configured = await open();
  assert.equal(configured.delegationNotifications, true);
  await executeDelegationCommand(["notifications", "off"], configured);
  assert.equal(configured.delegationNotifications, false);
  await configured.close();
  const overridden = await open({ delegationNotifications: false });
  assert.equal(overridden.delegationNotifications, false);
  await overridden.close();
  for (const invalid of ["on", 1, null]) {
    configuration.apps.maybecode.delegationNotifications = invalid;
    await writeFile(configPath, JSON.stringify(configuration));
    await assert.rejects(open(), /delegationNotifications must be boolean/u);
  }
});
