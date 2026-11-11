import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { loadMayConfig } from "@sortedyuan/may/config";
import type { Model, Tool } from "@sortedyuan/may/core";
import type { SelectedMaybeCodeModel } from "./model.js";

export interface RunMaybeCodeTeamDependencies {
  readonly write: (text: string) => void;
  readonly signal?: AbortSignal;
  readonly loadConfig?: typeof loadMayConfig;
  readonly createModel?: (selection: SelectedMaybeCodeModel) => Model;
}

export function createListTool(workspace: string): Tool<{ path: string }, unknown> {
  return {
    name: "list_files",
    description: "List up to 200 immediate non-symlink entries inside the isolated workspace.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Relative directory path; use . for root" } },
      required: ["path"],
      additionalProperties: false,
    },
    parse(input) {
      if (typeof input !== "object" || input === null || !("path" in input) || typeof input.path !== "string")
        throw new Error("list_files requires a relative path");
      return { path: input.path };
    },
    async execute(input, context) {
      context.signal.throwIfAborted();
      if (isAbsolute(input.path)) throw new Error("Absolute paths are not allowed");
      const target = resolve(workspace, input.path);
      if (!inside(workspace, target)) throw new Error("Path leaves the workspace");
      const parts = relative(workspace, target).split(sep).filter(Boolean);
      let cursor = workspace;
      for (const part of parts) {
        cursor = join(cursor, part);
        if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Symlink paths are not allowed");
      }
      const actual = await realpath(target);
      if (!inside(await realpath(workspace), actual)) throw new Error("Path leaves the workspace");
      const entries = (await readdir(actual, { withFileTypes: true }))
        .filter((entry) => !entry.isSymbolicLink())
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        path: input.path,
        entries: entries
          .slice(0, 200)
          .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" })),
        truncated: entries.length > 200,
      };
    },
  };
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}
