import { mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadMayConfig, type MayConfig } from "@sortedyuan/may/config";
import { resolveRunBudget, type RunBudget } from "@sortedyuan/may/core";
import { withFileAccess } from "@sortedyuan/may/storage";
import writeFileAtomic from "write-file-atomic";
import type { MaybeCodeTeamCommand } from "./args.js";
import { readMaybeCodeSettings, type MaybeCodeSettings } from "./settings.js";
import { selectMaybeCodeModel, type SelectedMaybeCodeModel } from "./model.js";
import type { RunMaybeCodeTeamDependencies } from "./team-common.js";
import { createTeamPreset, loadTeamPlan, parseTeamPlan, type TeamMode, type TeamPlan } from "./team-plan.js";
import { teamReviewDigest } from "./team-recovery.js";

export const VERSION = "maybecode-team-v2";
export const RESERVATION = 32_768;
const DEFAULT_RUN_BUDGET: RunBudget = { maxSteps: 10, maxModelCalls: 10, maxToolCalls: 24, maxDurationMs: 180_000 };
export interface Manifest {
  readonly lsp?: MaybeCodeSettings["lsp"];
  readonly execution?: MaybeCodeSettings["execution"];
  readonly fetch?: MaybeCodeSettings["fetch"];
  readonly format: 1;
  readonly version: typeof VERSION;
  readonly id: string;
  readonly createdAt: string;
  readonly workspace: string;
  readonly configPath: string;
  readonly model: string;
  readonly prompt: string;
  readonly mode: TeamMode;
  readonly allowChecks: boolean;
  readonly plan: TeamPlan;
  readonly roleModels: Readonly<
    Record<string, { readonly profile: string; readonly fingerprint: string; readonly runBudget: RunBudget }>
  >;
  readonly maxModelCalls: number;
  readonly maxTotalTokens: number;
  readonly maxConcurrent: number;
}

export async function createTeamManifest(
  command: MaybeCodeTeamCommand,
  dependencies: RunMaybeCodeTeamDependencies,
  id: string,
  directory: string,
): Promise<{ readonly manifest: Manifest; readonly config: MayConfig }> {
  if (!command.value.trim() || Buffer.byteLength(command.value) > 32_768)
    throw new Error("Team prompt must contain 1-32768 bytes");
  const workspace = await realpath(resolve(command.workspace ?? process.cwd()));
  if (!(await stat(workspace)).isDirectory() || inside(workspace, directory) || inside(directory, workspace))
    throw new Error("Team data directory must be outside and not overlap the source workspace");
  const mode = command.mode ?? "read-only";
  const plan = command.planPath
    ? await loadTeamPlan(command.planPath, { mode })
    : createTeamPreset(command.preset ?? "supervisor", command.value, {
        mode,
        ...(command.model ? { model: command.model } : {}),
      });
  const config = await (dependencies.loadConfig ?? loadMayConfig)(
    command.configPath ? { path: command.configPath } : {},
  );
  const fallback =
    command.model ??
    (Object.values(plan.roles).every((role) => role.model !== undefined)
      ? Object.values(plan.roles)[0]!.model
      : undefined);
  const defaultModel = selectMaybeCodeModel(config, fallback ? { model: fallback } : {});
  const roleModels: Record<string, Manifest["roleModels"][string]> = {};
  for (const [name, role] of Object.entries(plan.roles)) {
    const selected = selectMaybeCodeModel(config, { model: role.model ?? defaultModel.profile });
    const runBudget = resolveRunBudget(
      resolveRunBudget(readMaybeCodeSettings(config).runBudget, DEFAULT_RUN_BUDGET),
      role.runBudget,
    );
    roleModels[name] = { profile: selected.profile, fingerprint: modelFingerprint(selected), runBudget };
  }
  const manifest: Manifest = {
    execution: readMaybeCodeSettings(config).execution ?? { mode: "host" },
    fetch: readMaybeCodeSettings(config).fetch ?? {},
    lsp: readMaybeCodeSettings(config).lsp ?? false,
    format: 1,
    version: VERSION,
    id,
    createdAt: new Date().toISOString(),
    workspace,
    configPath: resolve(config.path),
    model: defaultModel.profile,
    prompt: command.value,
    mode,
    allowChecks: command.allowChecks === true,
    plan,
    roleModels,
    maxModelCalls: command.maxModelCalls ?? 32,
    maxTotalTokens: command.maxTotalTokens ?? 524_288,
    maxConcurrent: command.maxConcurrent ?? plan.limits?.maxConcurrent ?? 2,
  };
  validateManifest(manifest, id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeJson(join(directory, "manifest.json"), manifest, true);
  return { manifest, config };
}

export function modelFingerprint(selection: SelectedMaybeCodeModel): string {
  return teamReviewDigest({
    profile: selection.profile,
    provider: selection.provider,
    adapter: selection.adapter,
    model: selection.model,
    options: selection.options,
    baseURL: selection.providerConfig.baseURL,
    limits: selection.limits,
  });
}

export async function readManifest(directory: string, id: string): Promise<Manifest> {
  const path = join(directory, "manifest.json");
  return withFileAccess(path, "shared", async () => {
    if ((await stat(path)).size > 2_097_152) throw new Error("Team manifest exceeds limit");
    const value = JSON.parse(await readFile(path, "utf8")) as Manifest;
    validateManifest(value, id);
    return value;
  });
}
function validateManifest(value: Manifest, id: string): void {
  if (
    !value ||
    value.format !== 1 ||
    value.version !== VERSION ||
    value.id !== id ||
    !isAbsolute(value.workspace) ||
    !isAbsolute(value.configPath) ||
    typeof value.prompt !== "string" ||
    typeof value.model !== "string" ||
    !["coding", "read-only"].includes(value.mode) ||
    typeof value.allowChecks !== "boolean"
  )
    throw new Error("Invalid v2 team manifest");
  parseTeamPlan(value.plan, { mode: value.mode });
  if (
    ![value.maxModelCalls, value.maxTotalTokens, value.maxConcurrent].every((n) => Number.isSafeInteger(n) && n > 0) ||
    value.maxModelCalls > 10_000 ||
    value.maxConcurrent > 8 ||
    value.maxTotalTokens < RESERVATION
  )
    throw new Error("Invalid team limits; token budget must hold at least 32768 tokens");
  if (!value.roleModels || Object.keys(value.roleModels).length !== Object.keys(value.plan.roles).length)
    throw new Error("Invalid role model bindings");
  for (const name of Object.keys(value.plan.roles)) {
    const model = value.roleModels[name];
    if (!model || typeof model.profile !== "string" || !/^[a-f0-9]{64}$/u.test(model.fingerprint))
      throw new Error("Invalid role model binding");
    resolveRunBudget(model.runBudget);
  }
}

export async function writeJson(path: string, value: unknown, exclusive = false): Promise<void> {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  await withFileAccess(path, "exclusive", async () => {
    if (!exclusive) return writeFileAtomic(path, contents, { mode: 0o600 });
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }
  });
}
export function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}
