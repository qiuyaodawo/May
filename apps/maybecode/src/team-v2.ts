import { randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { TeamExecutionEnvironments } from "./team-execution.js";
import { loadMayConfig, type MayConfig } from "@sortedyuan/may/config";
import {
  CoordinationRuntime,
  FileArtifactStore,
  FileSharedBudget,
  TaskWorkspaceManager,
  type TaskExecution,
} from "@sortedyuan/coordination";
import { FileCoordinationStore } from "@sortedyuan/coordination/file-store";
import type { Model } from "@sortedyuan/may/core";
import { FileSessionStore } from "@sortedyuan/may/session/file-store";
import { hasErrorCode, withFileAccess } from "@sortedyuan/may/storage";
import type { MaybeCodeTeamCommand } from "./args.js";
import {
  getDefaultMaybeCodeDataDirectory,
  resolveMaybeCodeRecording,
  type MaybeCodeRecording,
} from "./configured-resolvers.js";
import { readMaybeCodeSettings } from "./settings.js";
import { createMaybeCodeModel, selectMaybeCodeModel, type SelectedMaybeCodeModel } from "./model.js";
import type { RunMaybeCodeTeamDependencies } from "./team-common.js";
import { TeamVerificationStore } from "./team-verification.js";
import { inspectTeam, readTeamResolution, retryImpact, teamReviewDigest } from "./team-recovery.js";
import {
  createTeamManifest,
  inside,
  modelFingerprint,
  readManifest,
  RESERVATION,
  VERSION,
  writeJson,
  type Manifest,
} from "./team-v2-manifest.js";
import { createTeamAgents } from "./team-v2-agents.js";
import { executionOf, runTeamPatchCommand, summarizeAcceptance } from "./team-v2-review.js";

/** Versioned host composition. Agents never receive recovery or source-application authority. */
export async function runTeamV2Command(
  command: MaybeCodeTeamCommand,
  dependencies: RunMaybeCodeTeamDependencies,
): Promise<number> {
  const id = command.action === "run" ? randomUUID() : command.value;
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(id)) throw new Error("Invalid team id");
  const directory = await canonicalPotentialPath(
    join(resolve(command.dataDirectory ?? getDefaultMaybeCodeDataDirectory()), "teams", id),
  );
  const write = (text: string) => dependencies.write(safeTerminal(text));
  let config: MayConfig | undefined;
  let manifest: Manifest;
  if (command.action === "run") ({ manifest, config } = await createTeamManifest(command, dependencies, id, directory));
  else manifest = await readManifest(directory, id);

  if (inside(manifest.workspace, directory) || inside(directory, manifest.workspace))
    throw new Error("Team data and source directories overlap");
  const authorityVersion = `${VERSION}-${teamReviewDigest({ mode: manifest.mode, allowChecks: manifest.allowChecks, plan: manifest.plan, roleModels: manifest.roleModels })}`;
  const budgetLimits = { maxModelCalls: manifest.maxModelCalls, maxTotalTokens: manifest.maxTotalTokens };
  if (command.action === "status") {
    write(`Team ${id}\nMode: ${manifest.mode}\nRecords: ${directory}\n`);
    write(await inspectTeam(directory, id, budgetLimits));
    // This projection is deliberately labeled: verify rechecks fingerprints under ownership.
    const path = join(directory, "acceptance.json");
    try {
      write(
        `Last acceptance projection (may be stale): ${await withFileAccess(path, "shared", () => readFile(path, "utf8"))}\n`,
      );
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }
    return 0;
  }
  if (command.action === "cancel") {
    await writeJson(join(directory, "cancel.request.json"), { id, requestedAt: new Date().toISOString() });
    write(`Cancellation requested for ${id}; active owner consumes it, otherwise resume to record cancellation.\n`);
    return 0;
  }

  const executes = command.action === "run" || command.action === "resume";
  const selections = new Map<string, SelectedMaybeCodeModel>();
  let recording: MaybeCodeRecording | undefined;
  if (executes) {
    config ??= await (dependencies.loadConfig ?? loadMayConfig)({ path: manifest.configPath });
    recording = resolveMaybeCodeRecording(config);
    for (const [name, binding] of Object.entries(manifest.roleModels)) {
      const selected = selectMaybeCodeModel(config, { model: binding.profile });
      if (modelFingerprint(selected) !== binding.fingerprint)
        throw new Error(`Model configuration changed for role ${name}; restore it before resuming`);
      selections.set(name, selected);
    }
  }

  const ledger = await FileSharedBudget.open(join(directory, "budget"), id, budgetLimits);
  const settings = readMaybeCodeSettings({
    providers: {},
    models: {},
    path: manifest.configPath,
    apps: {
      maybecode: {
        execution: manifest.execution ?? { mode: "host" },
        fetch: manifest.fetch ?? {},
        lsp: manifest.lsp ?? false,
      },
    },
  });
  const executionEnvironments = new TeamExecutionEnvironments(settings.execution, settings.lsp, directory);
  let workspaces: TaskWorkspaceManager | undefined;
  let artifacts: FileArtifactStore | undefined;
  let verification: TeamVerificationStore | undefined;
  let runtime: CoordinationRuntime | undefined;
  let relay: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let cancelling: Promise<void> | undefined;
  let retryAuthorized = false;
  const backgroundTasks = new Set<Promise<void>>();
  const backgroundErrors: unknown[] = [];
  let failBackground!: (error: unknown) => void;
  const backgroundFailed = new Promise<unknown>((resolve) => {
    failBackground = resolve;
  });
  const trackBackground = (operation: Promise<void>): void => {
    const task = operation.then(
      () => {
        backgroundTasks.delete(task);
      },
      (error) => {
        backgroundTasks.delete(task);
        backgroundErrors.push(error);
        failBackground(error);
        cancel();
      },
    );
    backgroundTasks.add(task);
  };
  const cancel = () => {
    if (runtime && !cancelling) {
      cancelling = runtime.cancel(`cancel-${id}`);
      trackBackground(cancelling);
    }
  };
  try {
    artifacts = await FileArtifactStore.open(join(directory, "artifacts"), id, {
      policyVersion: VERSION,
      authorizeRead: () => true,
      maxArtifacts: 256,
      maxArtifactBytes: 262_144,
      maxTotalBytes: 16_777_216,
    });
    workspaces = await TaskWorkspaceManager.open({
      sourceDirectory: manifest.workspace,
      directory: join(directory, "workspaces"),
    });
    verification = await TeamVerificationStore.open({
      directory: join(directory, "verification"),
      checks: manifest.plan.checks,
      executionFor: (workspace) => executionEnvironments.get(workspace),
    });
    const sessionStore = new FileSessionStore(join(directory, "sessions"));
    const models = new Map<string, Model>();
    const modelFor = (name: string) => {
      let model = models.get(name);
      if (!model) {
        const selected = selections.get(name);
        if (!selected) throw new Error("A host control command cannot start a model");
        const maxOutputTokens = Math.min(
          4096,
          selected.limits?.maxOutputTokens ?? 4096,
          ...[selected.options.maxTokens, selected.options.maxOutputTokens].filter(
            (n): n is number => typeof n === "number" && n > 0 && Number.isSafeInteger(n),
          ),
        );
        const selection = {
          ...selected,
          options: { ...selected.options, maxTokens: maxOutputTokens, maxOutputTokens },
          limits: { ...selected.limits, maxOutputTokens },
        };
        model = ledger.wrapModel((dependencies.createModel ?? createMaybeCodeModel)(selection), {
          reservation: { totalTokens: RESERVATION },
        });
        models.set(name, model);
      }
      return model;
    };
    const agents = createTeamAgents({
      manifest,
      authorityVersion,
      settings,
      config,
      recording,
      sessionStore,
      artifacts,
      workspaces,
      verification,
      executionEnvironments,
      modelFor,
      executionOf: (taskId) => executionOf(runtime!.snapshot(), taskId),
    });
    const options = {
      id,
      store: new FileCoordinationStore(join(directory, "coordination")),
      agents,
      policy: {
        version: authorityVersion,
        authorize: (task: { agent: string }) => Object.hasOwn(manifest.plan.roles, task.agent),
        authorizeDelegation: (parent: { agent: string }, child: { agent: string }) =>
          manifest.plan.roles[parent.agent]?.delegateTo.includes(child.agent) === true,
        authorizeMessage: (sender: { agent: string }, recipient: { agent: string }) =>
          manifest.plan.roles[sender.agent]?.messaging === true &&
          manifest.plan.roles[recipient.agent]?.messaging === true,
        authorizeRetry: (task: TaskExecution["task"], finding: string) => {
          if (retryAuthorized) return true;
          // Dispatch rechecks the exact durable host approval, not an ephemeral CLI flag.
          const state = runtime?.snapshot(),
            current = state?.tasks.find((entry) => entry.id === task.id);
          const previous = current?.attempts?.at(-1);
          if (
            current?.status !== "queued" ||
            !previous ||
            previous.task.dispatchId !== task.dispatchId ||
            previous.task.sessionId !== task.sessionId ||
            previous.finding !== finding ||
            !/^retry-[a-f0-9]{64}$/u.test(previous.commandId)
          )
            return false;
          const receipt = state?.commands[previous.commandId];
          if (!receipt) return false;
          const value = JSON.parse(receipt) as { type?: string; taskId?: string; finding?: string };
          return value.type === "retry" && value.taskId === task.id && value.finding === finding;
        },
      },
    };
    runtime =
      command.action === "run"
        ? await CoordinationRuntime.create({
            ...options,
            tasks: manifest.plan.tasks,
            limits: {
              maxTasks: 128,
              maxDepth: 2,
              maxTaskTurns: 4,
              maxDurationMs: 600_000,
              maxOutputBytes: 65_536,
              maxMessages: 24,
              maxMessageBytes: 8192,
              ...manifest.plan.limits,
              maxConcurrent: manifest.maxConcurrent,
            },
          })
        : await CoordinationRuntime.resume(options);
    write(
      `Team ${id}\nMode: ${manifest.mode}; source application requires a separate reviewed patch confirmation.\nRecords: ${directory}\n`,
    );
    if (manifest.allowChecks)
      write("Configured test processes explicitly authorized; no OS sandbox or automatic dependency installation.\n");
    relay = (async () => {
      const statuses = new Map<string, string>();
      for await (const event of runtime!.events) {
        if (event.type === "state.changed") {
          for (const task of event.snapshot.tasks)
            if (statuses.get(task.id) !== task.status) {
              statuses.set(task.id, task.status);
              write(`[${task.id}] ${task.status}${task.detail ? `: ${task.detail}` : ""}\n`);
            }
        } else if (
          event.type === "agent.event" &&
          event.event.type === "run.event" &&
          event.event.event.type === "tool.started"
        )
          write(`[${event.taskId}] tool ${event.event.event.call.name}\n`);
        else if (event.type === "runtime.failed") write("Team runtime failed; inspect recovery records.\n");
      }
    })();
    trackBackground(relay);

    if (command.action === "retry" || command.action === "reconcile") {
      const state = runtime.snapshot(),
        budget = await ledger.snapshot(),
        checks = await verification.snapshot();
      const operation =
        command.action === "retry"
          ? retryImpact(state, command.task!, command.finding!)
          : await readTeamResolution(command.resolutionPath!);
      // Resume may repeat evidence inspection and increment revision without changing meaning.
      const { revision: _revision, ...stableState } = state;
      const digest = teamReviewDigest({ operation, state: stableState, budget, checks });
      write(`${JSON.stringify(operation, null, 2)}\nReview digest: ${digest}\n`);
      if (!command.confirm) {
        write(
          "Preview only. Verify recorded effects/usage, then repeat with --confirm and this digest. No agent has executed.\n",
        );
        return 0;
      }
      if (command.confirm !== digest) throw new Error("Review digest changed or mismatched; inspect a fresh preview");
      if (command.action === "retry") {
        if (
          (await ledger.totals()).blocked ||
          checks.checks.some((check) => ["unknown", "pending"].includes(check.status))
        )
          throw new Error("Reconcile unknown usage/check effects before retrying; no reset or replay is allowed");
        retryAuthorized = true;
        await runtime.retryTask(`retry-${digest}`, command.task!, command.finding!);
      } else {
        const resolution = operation as Awaited<ReturnType<typeof readTeamResolution>>;
        if (resolution.kind === "budget")
          await ledger.reconcile(resolution.callId, resolution.usage, resolution.finding);
        else if (resolution.kind === "check")
          await verification.reconcile(resolution.commandId, { status: resolution.outcome }, resolution.finding);
        else
          await runtime.resolveRecovery(`resolve-${digest}`, resolution.taskId, resolution.finding, {
            status: resolution.outcome,
            detail: resolution.finding,
          });
      }
      write("Recorded. No agents or checks executed. Use team resume explicitly when ready.\n");
      return 0;
    }

    if (command.action === "diff" || command.action === "apply")
      return await runTeamPatchCommand({
        command,
        manifest,
        directory,
        runtime,
        ledger,
        workspaces,
        verification,
        write,
      });

    if (command.action === "verify") {
      if ((await verification.snapshot()).checks.some((check) => ["unknown", "pending"].includes(check.status)))
        throw new Error("Reconcile unknown check effects before running new verification");
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, ...(dependencies.signal ? [dependencies.signal] : [])]);
      const observeCancellation = async () => {
        const path = join(directory, "cancel.request.json");
        try {
          await withFileAccess(path, "shared", () => stat(path));
          controller.abort("Team verification cancelled");
        } catch (error) {
          if (!hasErrorCode(error, "ENOENT")) {
            controller.abort("Cannot establish cancellation state");
            throw error;
          }
        }
      };
      await observeCancellation();
      timer = setInterval(() => {
        trackBackground(observeCancellation());
      }, 300);
      const state = runtime.snapshot();
      for (const check of manifest.plan.checks) {
        if (signal.aborted) {
          write("Verification cancelled; interrupted command effects remain unknown until reconciled.\n");
          break;
        }
        if (state.tasks.find((task) => task.id === check.taskId)?.status !== "completed") {
          write(`Check ${check.id} skipped: task not completed.\n`);
          continue;
        }
        const workspace = await workspaces.prepare(check.taskId);
        const result = await verification.runCheck(`host-${randomUUID()}`, check, workspace.directory, {
          allowCommands: manifest.allowChecks,
          signal,
          execution: executionOf(state, check.taskId),
        });
        write(`Check ${check.id}: ${result.status}${result.detail ? ` (${result.detail})` : ""}\n`);
      }
      const acceptance = await summarizeAcceptance(directory, state, manifest, workspaces, verification);
      write(`Acceptance: ${acceptance.status}\n`);
      return !signal.aborted && acceptance.status === "passed" ? 0 : 1;
    }

    const checkCancellation = async () => {
      const path = join(directory, "cancel.request.json");
      try {
        await withFileAccess(path, "shared", () => stat(path));
        cancel();
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) {
          cancel();
          throw error;
        }
      }
    };
    dependencies.signal?.addEventListener("abort", cancel, { once: true });
    await checkCancellation();
    if (dependencies.signal?.aborted) cancel();
    timer = setInterval(() => {
      trackBackground(checkCancellation());
    }, 300);
    await cancelling;
    if (
      (await ledger.totals()).blocked ||
      (await verification.snapshot()).checks.some((check) => check.status === "unknown")
    ) {
      write(
        "Unknown usage/check effects or exceeded budget block execution. No new Run started; inspect and reconcile explicitly.\n",
      );
      return 1;
    }
    const result = await Promise.race([
      runtime.wait(),
      backgroundFailed.then((error) => {
        throw error;
      }),
    ]);
    await cancelling;
    const final = result.tasks.find((task) => task.id === manifest.plan.resultTaskId);
    if (final?.output?.text) write(`\n${final.output.text}\n`);
    const complete = result.tasks.every((task) => task.status === "completed");
    write(`\nTeam ${complete ? "completed" : "stopped with unfinished or failed tasks"}.\n`);
    for (const task of result.tasks) write(`  ${task.id}: ${task.status}\n`);
    const acceptance = await summarizeAcceptance(directory, result, manifest, workspaces, verification);
    write(
      `Acceptance: ${acceptance.status}. Completion is not a correctness guarantee.\nShared budget: ${JSON.stringify(await ledger.totals())}\n`,
    );
    for (const ref of await artifacts.snapshot()) write(`Artifact [${ref.ownerTaskId}]: ${JSON.stringify(ref)}\n`);
    if (!complete) write(`Inspect: team status ${id}; use explicit reconciliation/retry controls before resume.\n`);
    return complete && (!manifest.plan.checks.length || acceptance.status === "passed") ? 0 : 1;
  } finally {
    if (timer) clearInterval(timer);
    dependencies.signal?.removeEventListener("abort", cancel);
    try {
      const results = await Promise.allSettled([...(runtime ? [runtime.close()] : []), ...(relay ? [relay] : [])]);
      while (backgroundTasks.size) await Promise.all(backgroundTasks);
      const failures = [
        ...new Set([
          ...backgroundErrors,
          ...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
        ]),
      ];
      if (failures.length) throw new AggregateError(failures, "Team background operations failed");
    } finally {
      await Promise.all([
        verification?.close(),
        workspaces?.close(),
        artifacts?.close(),
        ledger.close(),
        executionEnvironments.close(),
      ]);
    }
  }
}

async function canonicalPotentialPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalPotentialPath(parent), relative(parent, path));
  }
}
function safeTerminal(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "");
}
