import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { TextEdit, WorkspaceEdit } from "vscode-languageserver-protocol/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { z } from "zod";
import {
  atomicWriteText,
  workspaceFileKey,
  type WorkspacePath,
  type WorkspaceFileFeedbackTicket,
  type WorkspaceFileGuard,
} from "@sortedyuan/coding-tools";
import { writeFileDurable } from "@sortedyuan/may/storage";
import type { FileDiagnostics, RenamePlan, RenameOutput, SymbolPosition } from "./types.js";
import { LspProtocolError, LspRenameConflictError, LspRenameWriteError } from "./errors.js";
import { hash, message } from "./text.js";

const journalSchema = z.object({
  files: z.array(z.object({ path: z.string(), original: z.string(), updatedHash: z.string() })),
});

export interface RenameFiles {
  path(input: string): Promise<WorkspacePath>;
  read(path: WorkspacePath, signal: AbortSignal): Promise<string>;
}
export interface RenamePlanInputs {
  readonly newName: string;
  readonly signal: AbortSignal;
  readonly maxFileBytes: number;
  readonly documents: ReadonlyMap<string, { readonly sentVersion: number }>;
  hostUri(uri: string): { host?: string; environmentPath: string };
  select(path: WorkspacePath): { language: string };
}
export interface RenameExecution {
  readonly signal: AbortSignal;
  readonly guard: WorkspaceFileGuard | undefined;
  record(path: WorkspacePath, content: string): WorkspaceFileFeedbackTicket | undefined;
}

async function buildRenamePlan(edit: WorkspaceEdit, deps: RenameFiles & RenamePlanInputs): Promise<RenamePlan> {
  const { newName, signal } = deps;
  if (edit.changes && edit.documentChanges)
    throw new LspProtocolError("Rename response contains both changes and documentChanges");
  const grouped = new Map<string, { edits: TextEdit[]; version: number | null }>();
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) grouped.set(uri, { edits, version: null });
  for (const change of edit.documentChanges ?? []) {
    if (!("textDocument" in change)) throw new LspProtocolError("Rename resource operations are not supported");
    if (grouped.has(change.textDocument.uri)) throw new LspProtocolError("Duplicate rename document");
    const edits: TextEdit[] = change.edits.map((entry) => {
      if (!("newText" in entry)) throw new LspProtocolError("Rename snippet edits are not supported");
      return entry;
    });
    grouped.set(change.textDocument.uri, { edits, version: change.textDocument.version });
  }
  if (grouped.size > 100 || [...grouped.values()].reduce((total, file) => total + file.edits.length, 0) > 5000)
    throw new LspProtocolError("Rename exceeds 100 files or 5000 edits");
  const files: RenamePlan["files"][number][] = [];
  const keys = new Set<string>();
  for (const [uri, change] of grouped) {
    const mapped = deps.hostUri(uri);
    if (!mapped.host) throw new LspProtocolError(`Rename outside workspace: ${mapped.environmentPath}`);
    const path = await deps.path(mapped.host);
    const key = workspaceFileKey(path);
    if (keys.has(key)) throw new LspProtocolError(`Duplicate rename file ${path.relative}`);
    keys.add(key);
    if (change.version !== null && change.version !== deps.documents.get(uri)?.sentVersion)
      throw new LspRenameConflictError(`Document version changed: ${path.relative}`);
    const original = await deps.read(path, signal);
    const document = TextDocument.create(uri, deps.select(path).language, change.version ?? 0, original);
    const ordered = [...change.edits].sort(
      (a, b) => document.offsetAt(a.range.start) - document.offsetAt(b.range.start),
    );
    let previousEnd = -1;
    for (const textEdit of ordered) {
      const start = document.offsetAt(textEdit.range.start);
      const end = document.offsetAt(textEdit.range.end);
      const actualStart = document.positionAt(start);
      const actualEnd = document.positionAt(end);
      if (
        start < previousEnd ||
        end < start ||
        actualStart.line !== textEdit.range.start.line ||
        actualStart.character !== textEdit.range.start.character ||
        actualEnd.line !== textEdit.range.end.line ||
        actualEnd.character !== textEdit.range.end.character
      )
        throw new LspProtocolError(`Invalid or overlapping rename edits: ${path.relative}`);
      previousEnd = end;
    }
    const updated = TextDocument.applyEdits(document, change.edits);
    if (Buffer.byteLength(updated) > deps.maxFileBytes)
      throw new LspProtocolError(`Renamed file exceeds maxFileBytes: ${path.relative}`);
    files.push({
      path,
      original,
      updated,
      originalHash: hash(original),
      updatedHash: hash(updated),
      edits: change.edits,
    });
  }
  return Object.freeze({
    files: Object.freeze(
      files.map((file) =>
        Object.freeze({
          ...file,
          path: Object.freeze(file.path),
          edits: Object.freeze(
            file.edits.map((edit) =>
              Object.freeze({
                ...edit,
                range: Object.freeze({ start: Object.freeze(edit.range.start), end: Object.freeze(edit.range.end) }),
              }),
            ),
          ),
        }),
      ),
    ),
    newName,
  });
}

export class RenameTransactions {
  private readonly journal: string;
  private readonly files: RenameFiles;
  private readonly plans = new Map<string, { input: string; plan: RenamePlan }>();
  private readonly ownedPlans = new WeakSet<RenamePlan>();
  private readonly usedPlans = new WeakSet<RenamePlan>();
  private transaction: Promise<unknown> = Promise.resolve();

  constructor(journal: string, files: RenameFiles) {
    this.journal = journal;
    this.files = files;
  }

  async recover(): Promise<string | undefined> {
    await mkdir(dirname(this.journal), { recursive: true });
    if ((await readdir(dirname(this.journal))).includes(this.journal.split(/[\\/]/u).at(-1)!)) {
      const journal = journalSchema.parse(JSON.parse(await readFile(this.journal, "utf8")));
      const recovered: string[] = [];
      for (const file of journal.files) {
        const path = await this.files.path(file.path);
        const content = await this.files.read(path, new AbortController().signal);
        if (hash(content) === file.updatedHash) {
          await atomicWriteText(path.absolute, file.original, new AbortController().signal);
          recovered.push(path.relative);
        }
      }
      await rm(this.journal);
      return `Recovered rename transaction: ${recovered.join(", ")}`;
    }
    return undefined;
  }
  async plan(edit: WorkspaceEdit, deps: RenamePlanInputs): Promise<RenamePlan> {
    const plan = await buildRenamePlan(edit, {
      ...deps,
      path: (input) => this.files.path(input),
      read: (path, signal) => this.files.read(path, signal),
    });
    this.ownedPlans.add(plan);
    return plan;
  }
  cache(toolCallId: string, input: SymbolPosition & { readonly newName: string }, plan: RenamePlan): void {
    if (!this.ownedPlans.has(plan)) throw new TypeError("Rename plan belongs to another manager");
    this.plans.set(toolCallId, { input: JSON.stringify(input), plan });
    if (this.plans.size > 100) this.plans.delete(this.plans.keys().next().value!);
  }
  take(toolCallId: string, input: SymbolPosition & { readonly newName: string }): RenamePlan | undefined {
    const cached = this.plans.get(toolCallId);
    this.plans.delete(toolCallId);
    if (cached && cached.input !== JSON.stringify(input))
      throw new LspRenameConflictError("Rename input changed after preview");
    return cached?.plan;
  }
  async execute(plan: RenamePlan, deps: RenameExecution): Promise<RenameOutput> {
    const { signal, guard } = deps;
    if (!this.ownedPlans.has(plan) || this.usedPlans.has(plan))
      throw new TypeError("Invalid or already executed rename plan");
    const operation = async () => {
      signal.throwIfAborted();
      const paths = await Promise.all(plan.files.map((file) => this.files.path(file.path.relative)));
      const tickets: { path: string; ticket: WorkspaceFileFeedbackTicket }[] = [];
      const write = async () => {
        for (const [index, file] of plan.files.entries())
          if (
            workspaceFileKey(paths[index]!) !== workspaceFileKey(file.path) ||
            hash(await this.files.read(paths[index]!, signal)) !== file.originalHash
          )
            throw new LspRenameConflictError(`File changed after rename preview: ${file.path.relative}`);
        await writeFileDurable(
          this.journal,
          JSON.stringify({
            files: plan.files.map((file) => ({
              path: file.path.relative,
              original: file.original,
              updatedHash: file.updatedHash,
            })),
          }),
        );
        const written: (typeof plan.files)[number][] = [];
        let failedPath = "";
        try {
          for (const file of plan.files) {
            failedPath = file.path.relative;
            await atomicWriteText(file.path.absolute, file.updated, signal);
            written.push(file);
          }
        } catch (error) {
          const restored: string[] = [];
          const errors: string[] = [];
          for (const file of written.reverse()) {
            try {
              await atomicWriteText(file.path.absolute, file.original, new AbortController().signal);
              restored.push(file.path.relative);
            } catch (restoreError) {
              errors.push(`${file.path.relative}: ${message(restoreError)}`);
            }
          }
          if (!errors.length) await rm(this.journal);
          throw new LspRenameWriteError(
            `Rename failed at ${failedPath}: ${message(error)}. Restored: ${restored.join(", ")}. Recovery errors: ${errors.join(", ")}`,
            { cause: error },
          );
        }
        await rm(this.journal);
        this.usedPlans.add(plan);
        for (const file of plan.files) {
          const ticket = deps.record(file.path, file.updated);
          if (ticket) tickets.push({ path: file.path.relative, ticket });
        }
      };
      if (guard) await guard.runMany(paths, "lsp_rename", write);
      else await write();
      const diagnostics: Record<string, FileDiagnostics> = {};
      await Promise.all(
        tickets.map(async ({ path, ticket }) => {
          diagnostics[path] = (await ticket.result(signal)).diagnostics;
        }),
      );
      return { files: plan.files.map((file) => ({ path: file.path.relative, edits: file.edits.length })), diagnostics };
    };
    const result = this.transaction.then(operation);
    this.transaction = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  settled(): Promise<unknown> {
    return this.transaction;
  }
  clear(): void {
    this.plans.clear();
  }
}
