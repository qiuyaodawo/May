import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { WorkspacePatchChange, WorkspacePatchSnapshot } from "@sortedyuan/coordination";
import { assertRelativePath, hash } from "./team-patch-files.js";

export const MAX_BUNDLE_BYTES = 16_777_216;
export const MAX_FILE_BYTES = 262_144;
const MAX_TOTAL_BYTES = 2_097_152;

export interface TeamPatchFile extends Omit<WorkspacePatchChange, "taskId"> {
  readonly taskIds: readonly string[];
}
export interface TeamPatchConflict {
  readonly path: string;
  readonly candidates: readonly TeamPatchFile[];
}
interface TeamPatchPayload {
  readonly format: 1;
  readonly sourceDirectory: string;
  readonly baselineDigest: string;
  readonly taskSnapshots: WorkspacePatchSnapshot["taskSnapshots"];
  readonly files: readonly TeamPatchFile[];
  readonly conflicts: readonly TeamPatchConflict[];
}
export interface TeamPatchBundle extends TeamPatchPayload {
  readonly id: string;
  readonly digest: string;
}

/** Full-file unified hunks intentionally favor exact, bounded evidence over heuristic merging. */
export function renderTeamPatchDiff(bundle: TeamPatchBundle): string {
  validateBundle(bundle, bundle.id);
  const sections = [
    `Patch ${bundle.id}`,
    `Confirm digest: ${bundle.digest}`,
    `Tasks: ${bundle.taskSnapshots.map((task) => task.taskId).join(", ")}`,
  ];
  for (const file of bundle.files) sections.push(fileDiff(file));
  for (const conflict of bundle.conflicts) {
    sections.push(`CONFLICT ${conflict.path}: different task results; apply is blocked.`);
    for (const file of conflict.candidates)
      sections.push(`Candidate tasks: ${file.taskIds.join(", ")}\n${fileDiff(file)}`);
  }
  if (bundle.files.length === 0 && bundle.conflicts.length === 0) sections.push("No source changes.");
  return `${sections.join("\n\n")}\n`;
}

export function bundleFrom(snapshot: WorkspacePatchSnapshot): TeamPatchBundle {
  const groups = new Map<string, TeamPatchFile[]>();
  for (const { taskId, ...change } of snapshot.changes) {
    assertRelativePath(change.path);
    const group = groups.get(change.path) ?? [];
    const identical = group.find((file) =>
      isDeepStrictEqual({ ...file, taskIds: undefined }, { ...change, taskIds: undefined }),
    );
    if (identical) group[group.indexOf(identical)] = { ...identical, taskIds: [...identical.taskIds, taskId].sort() };
    else group.push({ ...change, taskIds: [taskId] });
    groups.set(change.path, group);
  }
  const payload: TeamPatchPayload = {
    format: 1,
    sourceDirectory: snapshot.sourceDirectory,
    baselineDigest: snapshot.baselineDigest,
    taskSnapshots: [...snapshot.taskSnapshots].sort((a, b) => a.taskId.localeCompare(b.taskId)),
    files: [],
    conflicts: [],
  };
  const files: TeamPatchFile[] = [];
  const conflicts: TeamPatchConflict[] = [];
  const aliases = new Map<string, string>();
  for (const [path, candidates] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const alias = process.platform === "win32" ? path.toLowerCase() : path;
    if (aliases.has(alias) && aliases.get(alias) !== path) throw new Error("Patch contains filesystem path aliases");
    aliases.set(alias, path);
    if (candidates.length === 1) files.push(candidates[0]!);
    else conflicts.push({ path, candidates });
  }
  const body = { ...payload, files, conflicts };
  const digest = hash(JSON.stringify(body));
  const bundle = { ...body, id: `patch-${digest}`, digest };
  validateBundle(bundle, bundle.id);
  return bundle;
}

export function validateBundle(bundle: TeamPatchBundle, expectedId: string): void {
  assertPatchId(expectedId);
  if (
    !bundle ||
    bundle.format !== 1 ||
    bundle.id !== expectedId ||
    bundle.id !== `patch-${bundle.digest}` ||
    !isAbsolute(bundle.sourceDirectory) ||
    !/^[a-f0-9]{64}$/u.test(bundle.baselineDigest) ||
    !Array.isArray(bundle.taskSnapshots) ||
    !bundle.taskSnapshots.length ||
    !Array.isArray(bundle.files) ||
    !Array.isArray(bundle.conflicts)
  )
    throw new Error("Invalid patch bundle");
  const { id: _id, digest, ...body } = bundle;
  if (hash(JSON.stringify(body)) !== digest) throw new Error("Patch digest does not match its content");
  const ids = new Set<string>();
  for (const task of bundle.taskSnapshots) {
    if (typeof task.taskId !== "string" || !task.taskId || ids.has(task.taskId) || !/^[a-f0-9]{64}$/u.test(task.digest))
      throw new Error("Invalid patch task identity");
    ids.add(task.taskId);
  }
  let total = 0;
  const records = [...bundle.files, ...bundle.conflicts.flatMap((conflict) => conflict.candidates)];
  if (records.length > 128) throw new Error("Patch has too many file records");
  for (const file of records) {
    assertRelativePath(file.path);
    if (
      !["added", "modified", "deleted"].includes(file.kind) ||
      !Array.isArray(file.taskIds) ||
      !file.taskIds.length ||
      file.taskIds.some((id: unknown) => typeof id !== "string" || !ids.has(id))
    )
      throw new Error("Invalid patch file ownership");
    for (const prefix of ["before", "after"] as const) {
      const text = file[`${prefix}Text`];
      const sha = file[`${prefix}Sha256`];
      const expected = prefix === "before" ? file.kind !== "added" : file.kind !== "deleted";
      if (
        expected
          ? typeof text !== "string" ||
            sha !== hash(text) ||
            /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/u.test(text)
          : text !== undefined || sha !== undefined
      )
        throw new Error("Invalid patch file content/hash or unsafe display controls");
      if (text !== undefined) {
        const bytes = Buffer.byteLength(text);
        if (bytes > MAX_FILE_BYTES) throw new Error("Patch file exceeds its byte limit");
        total += bytes;
      }
    }
  }
  if (total > MAX_TOTAL_BYTES) throw new Error("Patch exceeds its total byte limit");
}

function fileDiff(file: TeamPatchFile): string {
  const old = lines(file.beforeText);
  const next = lines(file.afterText);
  const rendered = [
    `diff --git a/${file.path} b/${file.path}`,
    `--- ${file.beforeText === undefined ? "/dev/null" : `a/${file.path}`}`,
    `+++ ${file.afterText === undefined ? "/dev/null" : `b/${file.path}`}`,
    `@@ -${old.length ? 1 : 0},${old.length} +${next.length ? 1 : 0},${next.length} @@`,
  ];
  for (const [prefix, entries, text] of [
    ["-", old, file.beforeText],
    ["+", next, file.afterText],
  ] as const) {
    for (const line of entries) rendered.push(`${prefix}${line}`);
    if (entries.length && !text!.endsWith("\n")) rendered.push("\\ No newline at end of file");
  }
  return rendered.join("\n");
}

function lines(text?: string): string[] {
  if (!text) return [];
  const result = text.split("\n");
  if (text.endsWith("\n")) result.pop();
  return result;
}

export function assertPatchId(id: string): void {
  if (!/^patch-[a-f0-9]{64}$/u.test(id)) throw new Error("Invalid patch id");
}
