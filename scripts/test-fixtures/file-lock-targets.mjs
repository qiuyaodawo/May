import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { acquireFileLock } from "../../packages/may/dist/storage/index.js";
import { FilePermissionRuleStore } from "../../packages/may/dist/permissions/file-store.js";
import { FileCoordinationStore } from "../../packages/coordination/dist/file-store.js";
import { ResourceJournal } from "../../packages/coordination/dist/resource-journal.js";
import { CoordinationWorker } from "../../packages/coordination/dist/remote-worker.js";
import { ProjectGitWorkspace } from "../../packages/may/dist/application/git-workspace.js";
import { updateDefaultMayModel } from "../../packages/may/dist/config/index.js";
import { GatewayStore } from "../../apps/maybeclaw/dist/gateway-store.js";
import { startGatewaySetup } from "../../apps/maybeclaw/dist/gateway-setup.js";
import { TeamVerificationStore } from "../../apps/maybecode/dist/team-verification.js";
import { TaskWorkspaceManager } from "../../packages/coordination/dist/task-workspace.js";
import { applyTeamPatch, createTeamPatch } from "../../apps/maybecode/dist/team-patches.js";

const run = promisify(execFile);
export const targetNames = [
  "session", "permissions", "coordination", "resource", "worker",
  "gateway", "setup", "verification", "git", "config", "patch",
];
export const configuration = {
  providers: { local: { adapter: "openai-responses" } },
  models: { first: { provider: "local", model: "first" }, second: { provider: "local", model: "second" } },
  defaultModel: "first",
};

export async function targetFor(name, directory, initialize = false) {
  const path = join(directory, "state.json");
  if (initialize) await mkdir(directory, { recursive: true });
  if (name === "session") {
    const lockPath = join(directory, "owner.lock");
    return { lockPath, async acquire() {
      const lock = await acquireFileLock(lockPath);
      return { close: () => lock.release() };
    } };
  }
  if (name === "permissions") return {
    lockPath: `${path}.lock`, failurePath: path,
    acquire: () => FilePermissionRuleStore.open({ path }),
  };
  if (name === "coordination") return {
    lockPath: join(directory, "dGFzaw.lock"), failurePath: join(directory, "dGFzaw.jsonl"),
    acquire: () => new FileCoordinationStore(directory).acquire("task"),
  };
  if (name === "resource") return {
    lockPath: `${path}.lock`, failurePath: path,
    acquire: () => ResourceJournal.open(path, { format: 1, revision: 0 }, value => {
      assert.equal(value.format, 1);
      assert.ok(Number.isSafeInteger(value.revision) && value.revision >= 0);
    }),
  };
  if (name === "worker") return {
    lockPath: join(directory, "worker.lock"), failurePath: join(directory, "worker.jsonl"),
    acquire: () => CoordinationWorker.open({
      directory, token: "local-lock-verification-token-0123456789", agents: {}, authorize: () => false,
    }),
  };
  if (name === "gateway") return {
    lockPath: join(directory, "host.lock"), failurePath: join(directory, "gateway.sqlite"),
    acquire: async () => { const store = GatewayStore.open(directory); return { close: async () => store.close() }; },
  };
  if (name === "setup") return {
    lockPath: `${path}.initialize.lock`, failurePath: path,
    acquire: () => startGatewaySetup({
      path, port: 0, activate: async () => { throw new Error("This setup process does not activate a gateway"); },
    }),
  };
  if (name === "verification") return {
    lockPath: join(directory, "verification.jsonl.lock"), failurePath: join(directory, "verification.jsonl"),
    acquire: () => TeamVerificationStore.open({ directory }),
  };
  if (name === "git") {
    const workspace = join(directory, "project");
    if (initialize) {
      await mkdir(workspace);
      await run("git", ["init", workspace], { windowsHide: true });
    }
    const manager = await ProjectGitWorkspace.open({
      workspace, dataRoot: join(directory, "records"), worktreesRoot: join(directory, "worktrees"), autoCommit: false,
    });
    const scope = createHash("sha256").update(manager.repository).digest("hex").slice(0, 24);
    const base = join(directory, "records", manager.projectId, scope);
    return {
      lockPath: `${base}.lock`, failurePath: `${base}.intent.json`,
      acquire: () => manager.beginRound({ sessionId: "file-lock-verification" }),
    };
  }
  if (name === "config") {
    if (initialize) await writeFile(path, JSON.stringify(configuration));
    return {
      lockPath: `${path}.lock`, failurePath: path, oneShot: true, dataPath: path,
      async acquire() {
        await updateDefaultMayModel(path, "second");
        return { close: async () => {} };
      },
    };
  }
  if (name === "patch") {
    const sourceDirectory = join(directory, "source");
    const teamDirectory = join(directory, "team");
    const workspaceOptions = { sourceDirectory, directory: join(teamDirectory, "workspaces") };
    const descriptorPath = join(directory, "patch.json");
    if (initialize) {
      await mkdir(sourceDirectory);
      await writeFile(join(sourceDirectory, "value.txt"), "before\n");
      const workspaces = await TaskWorkspaceManager.open(workspaceOptions);
      try {
        const task = await workspaces.prepare("worker");
        await writeFile(join(task.directory, "value.txt"), "after\n");
        const patch = await createTeamPatch({ directory: teamDirectory, workspaces, taskIds: ["worker"] });
        await writeFile(descriptorPath, JSON.stringify({ patchId: patch.id, confirmDigest: patch.digest }));
      } finally { await workspaces.close(); }
    }
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    const lockDirectory = join(homedir(), ".may", "maybecode", "apply-locks");
    if (initialize) await mkdir(lockDirectory, { recursive: true });
    const lockPath = join(lockDirectory, `${createHash("sha256").update(sourceDirectory).digest("hex")}.lock`);
    return {
      lockPath, oneShot: true, cleanupFiles: [lockPath, `${lockPath}.owner`],
      failurePath: join(teamDirectory, "patches", "applications", descriptor.patchId, "apply.jsonl"),
      async acquire() {
        const workspaces = await TaskWorkspaceManager.open(workspaceOptions);
        try {
          const result = await applyTeamPatch({ directory: teamDirectory, workspaces, ...descriptor });
          assert.equal(result.status, "applied", result.detail);
          assert.equal(await readFile(join(sourceDirectory, "value.txt"), "utf8"), "after\n");
          return { close: async () => {} };
        } finally { await workspaces.close(); }
      },
    };
  }
  throw new Error(`Unknown file lock target: ${name}`);
}
