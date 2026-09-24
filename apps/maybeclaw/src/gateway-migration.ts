import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { SessionEvent } from "@may/session";
import { FileSessionStore, syncDirectory } from "@may/session/file-store";
import { ChannelStore, type ChannelRecord, type InboxRecord } from "./channel-store.js";
import { GatewayStore } from "./gateway-store.js";
import { inspectLegacyTaskEvidence } from "./service.js";
import { FileTaskStore, isMissing } from "./store.js";
import { isTerminal, type TaskSnapshot } from "./types.js";

export interface LegacyTaskRecord {
  id: string;
  snapshot: TaskSnapshot;
  status: "completed" | "failed" | "cancelled" | "awaiting-assignment" | "recovery-required";
  history: readonly SessionEvent[];
  origins: readonly Pick<InboxRecord["input"], "account" | "sender" | "conversation" | "eventId">[];
  cancellationRequested: boolean;
  result?: string;
  detail?: string;
}

export interface LegacyCounts {
  tasks: number;
  inbox: number;
  deliveries: number;
  cursors: number;
  awaitingAssignment: number;
  recoveryRequired: number;
  unknownDeliveries: number;
}

export interface LegacyCheck extends LegacyCounts {
  hasLegacy: boolean;
  migrated: boolean;
  canMigrate: boolean;
  owners: string[];
  warnings: string[];
}

export interface LegacyMigrationResult {
  version: 1;
  directory: string;
  backupDirectory: string;
  migratedAt: number;
  fingerprint: string;
  counts: LegacyCounts;
  alreadyMigrated: boolean;
}

interface LegacySource {
  check: LegacyCheck;
  tasks: LegacyTaskRecord[];
  channels: ChannelRecord[];
  files: string[];
}

export async function checkLegacy(directory: string): Promise<LegacyCheck> {
  return (await inspectSource(resolve(directory))).check;
}

export async function migrateLegacy(directory: string): Promise<LegacyMigrationResult> {
  const resolved = resolve(directory);
  const initial = await inspectSource(resolved);
  if (initial.check.owners.length) throw new Error("Legacy data has an owner lock; stop its owner and resolve the lock before migration");
  if (!initial.check.hasLegacy && !initial.check.migrated) throw new Error("No legacy MaybeClaw data found");
  const store = GatewayStore.open(resolved);
  try {
    const previous = store.get<LegacyMigrationResult>("metadata", "legacy-migration");
    if (previous) {
      await ensureFormatMarker(resolved);
      return { ...previous, alreadyMigrated: true };
    }
    if (initial.check.migrated) throw new Error("Gateway migration marker has no matching database record");
    const source = await inspectSource(resolved, true);
    if (source.check.owners.length) throw new Error("Legacy task ownership changed during migration");
    const fingerprint = await fingerprintFiles(resolved, source.files);
    const backupDirectory = join(resolved, "legacy-backups", `${Date.now()}-${randomUUID()}`);
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    for (const path of source.files) {
      const target = join(backupDirectory, path);
      await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
      await copyFile(join(resolved, path), target);
      await chmod(target, 0o600);
    }
    const configPaths = [...new Set(source.tasks.map((task) => task.snapshot.spec.configPath))];
    const configs: { source: string; backup?: string; unavailable?: true }[] = [];
    for (const [index, path] of configPaths.entries()) {
      if (!await exists(path)) { configs.push({ source: path, unavailable: true }); continue; }
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Legacy configuration backup requires regular files");
      const target = join("configuration", `${index}.json`);
      await mkdir(join(backupDirectory, "configuration"), { recursive: true, mode: 0o700 });
      await copyFile(path, join(backupDirectory, target));
      await chmod(join(backupDirectory, target), 0o600);
      configs.push({ source: path, backup: target });
    }
    const verified = await inspectSource(resolved, true);
    if (verified.check.owners.length || await fingerprintFiles(resolved, verified.files) !== fingerprint
      || await fingerprintFiles(backupDirectory, source.files) !== fingerprint) {
      throw new Error("Legacy data changed during backup; migration was not applied");
    }
    const result: LegacyMigrationResult = { version: 1, directory: resolved, backupDirectory, migratedAt: Date.now(),
      fingerprint, counts: counts(source.tasks, source.channels), alreadyMigrated: false };
    await writePrivate(join(backupDirectory, "manifest.json"), { ...result, files: source.files, configurations: configs });
    store.transaction(() => {
      for (const task of source.tasks) store.put("legacy-tasks", task.id, task);
      for (const record of source.channels) {
        if (record.kind === "inbox") store.put("legacy-inbox", record.id, record);
        else if (record.kind === "cursor") store.put("legacy-cursors", record.id, record);
        else store.put("legacy-deliveries", record.id, { ...record, status: record.status === "sending" ? "unknown" : record.status });
      }
      store.put("metadata", "legacy-migration", result);
    });
    await ensureFormatMarker(resolved);
    return result;
  } finally { store.close(); }
}

async function inspectSource(directory: string, ownHostLock = false): Promise<LegacySource> {
  const owners: string[] = [];
  if (!ownHostLock && await exists(join(directory, "host.lock"))) owners.push("host.lock");
  const files: string[] = [];
  for (const name of ["tasks", "sessions"]) await collectFiles(directory, name, files, owners);
  if (await exists(join(directory, "channels.jsonl"))) files.push("channels.jsonl");
  const snapshots = await new FileTaskStore(directory).list();
  const channels = await exists(join(directory, "channels.jsonl")) ? await ChannelStore.inspect(join(directory, "channels.jsonl")) : [];
  const known = new Set(snapshots.map((task) => task.id));
  const records = new Map(channels.map((record) => [record.id, record]));
  for (const record of channels) {
    if (record.kind !== "cursor" && record.taskId !== undefined && !known.has(record.taskId)) throw new Error("Legacy channel record references a missing task");
    if (record.kind === "delivery" && record.after !== undefined) {
      const previous = records.get(record.after);
      if (previous?.kind !== "delivery" || previous.id === record.id || previous.account !== record.account
        || previous.sender !== record.sender || previous.conversation !== record.conversation) throw new Error("Invalid legacy delivery dependency");
      const chain = new Set([record.id]);
      let current: ChannelRecord | undefined = previous;
      while (current?.kind === "delivery" && current.after !== undefined) {
        if (chain.has(current.id)) throw new Error("Cyclic legacy delivery dependency");
        chain.add(current.id);
        current = records.get(current.after);
      }
    }
  }
  const sessionStore = new FileSessionStore(join(directory, "sessions"));
  const taskStore = new FileTaskStore(directory);
  const tasks: LegacyTaskRecord[] = [];
  const warnings: string[] = [];
  for (const snapshot of snapshots) {
    const history = await sessionStore.inspect(snapshot.id);
    const evidence = inspectLegacyTaskEvidence(snapshot, history);
    const cancellationRequested = await taskStore.hasCancel(snapshot.id);
    const status = isTerminal(snapshot) ? snapshot.status as "completed" | "failed" | "cancelled"
      : evidence.status === "queued" ? cancellationRequested ? "cancelled" : "awaiting-assignment"
      : evidence.status === "blocked" || evidence.status === "running" ? "recovery-required" : evidence.status;
    const origins = channels.filter((record): record is InboxRecord => record.kind === "inbox" && record.taskId === snapshot.id)
      .map(({ input }) => ({ account: input.account, sender: input.sender, conversation: input.conversation, eventId: input.eventId }));
    const result = snapshot.result ?? evidence.result;
    const detail = snapshot.detail ?? evidence.detail;
    tasks.push({ id: snapshot.id, snapshot, status, history, origins,
      cancellationRequested,
      ...(result === undefined ? {} : { result }), ...(detail === undefined ? {} : { detail }) });
    if (origins.length === 0) warnings.push(`Task ${snapshot.id} has no verified channel origin; administrator access is required`);
    if (!await exists(snapshot.spec.configPath)) warnings.push(`Task ${snapshot.id} configuration is unavailable for backup`);
  }
  const expectedHistories = new Set(snapshots.map((task) => join("sessions", `${Buffer.from(task.id).toString("base64url")}.jsonl`)));
  for (const file of files) {
    if (file.startsWith(`tasks${process.platform === "win32" ? "\\" : "/"}`) && file.endsWith(".jsonl")
      && !/^[a-f0-9]{64}\.jsonl$/u.test(file.slice("tasks".length + 1))) throw new Error("Invalid legacy task journal filename");
    if (file.startsWith(`sessions${process.platform === "win32" ? "\\" : "/"}`) && file.endsWith(".jsonl") && !expectedHistories.has(file)) {
      throw new Error("Legacy session history has no matching task");
    }
  }
  const migrated = await hasFormatMarker(directory);
  return { check: { ...counts(tasks, channels), hasLegacy: files.length > 0, migrated,
    canMigrate: owners.length === 0, owners, warnings }, tasks, channels, files: files.sort() };
}

function counts(tasks: readonly LegacyTaskRecord[], channels: readonly ChannelRecord[]): LegacyCounts {
  return { tasks: tasks.length, inbox: channels.filter((record) => record.kind === "inbox").length,
    deliveries: channels.filter((record) => record.kind === "delivery").length,
    cursors: channels.filter((record) => record.kind === "cursor").length,
    awaitingAssignment: tasks.filter((task) => task.status === "awaiting-assignment").length,
    recoveryRequired: tasks.filter((task) => task.status === "recovery-required").length,
    unknownDeliveries: channels.filter((record) => record.kind === "delivery" && ["sending", "unknown"].includes(record.status)).length };
}

async function collectFiles(directory: string, subdirectory: string, files: string[], owners: string[]): Promise<void> {
  const path = join(directory, subdirectory);
  if (!await exists(path)) return;
  if (!(await lstat(path)).isDirectory()) throw new Error("Legacy data path must be a directory");
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const name = join(subdirectory, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("Legacy data requires regular files");
    if (entry.name.endsWith(".lock")) owners.push(name);
    else files.push(name);
  }
}

async function fingerprintFiles(directory: string, files: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const file of files) {
    const path = join(directory, file);
    if (relative(directory, path).startsWith("..") || !(await lstat(path)).isFile()) throw new Error("Invalid legacy source file");
    const bytes = await readFile(path);
    hash.update(file).update("\0").update(String(bytes.length)).update("\0").update(bytes);
  }
  return hash.digest("hex");
}

async function hasFormatMarker(directory: string): Promise<boolean> {
  const path = join(directory, "gateway.format.json");
  if (!await exists(path)) return false;
  const marker = JSON.parse(await readFile(path, "utf8")) as { version?: unknown; format?: unknown };
  if (marker.version !== 1 || marker.format !== "maybeclaw-gateway") throw new Error("Unsupported Gateway format marker");
  return true;
}

async function ensureFormatMarker(directory: string): Promise<void> {
  if (await hasFormatMarker(directory)) return;
  const temporary = join(directory, `gateway.format.${randomUUID()}.json.tmp`);
  await writePrivate(temporary, { version: 1, format: "maybeclaw-gateway" });
  await rename(temporary, join(directory, "gateway.format.json"));
  await syncDirectory(directory);
}

async function writePrivate(path: string, value: unknown): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + "\n"); await file.sync(); }
  finally { await file.close(); }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if (isMissing(error)) return false; throw error; }
}
