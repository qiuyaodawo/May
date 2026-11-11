import { omitUndefined, type Tool } from "@sortedyuan/may/core";
import type { WorkspaceFileGuard } from "./guard.js";
import { createEditTool, type EditToolOptions } from "./edit.js";
import { createReadTool, type ReadToolOptions } from "./read.js";
import { createShellTool, type ShellToolOptions } from "./shell.js";
import { createWriteTool, type WriteToolOptions } from "./write.js";
import { createGlobTool } from "./glob.js";
import { createGrepTool } from "./grep.js";
import { createFetchTool, type FetchToolOptions } from "./fetch.js";
import type { CodingExecutionEnvironment } from "./execution.js";
import type { WorkspaceFileFeedback } from "./file-feedback.js";

/** @experimental */
export type CodingToolName = "read" | "shell" | "edit" | "write" | "glob" | "grep" | "fetch";

/** @experimental */
export interface CodingToolsOptions {
  readonly cwd: string;
  readonly execution?: CodingExecutionEnvironment;
  readonly fetch?: FetchToolOptions;
  readonly read?: Omit<ReadToolOptions, "cwd">;
  readonly shell?: Omit<ShellToolOptions, "cwd">;
  readonly edit?: Omit<EditToolOptions, "cwd">;
  readonly write?: Omit<WriteToolOptions, "cwd">;
  /** 宿主守卫：读取、修改与写入都在同一把文件锁内完成。 */
  readonly guard?: WorkspaceFileGuard;
  readonly fileFeedback?: WorkspaceFileFeedback;
}

/** @experimental */
export function createCodingTool(name: CodingToolName, options: CodingToolsOptions): Tool {
  switch (name) {
    case "read":
      return createReadTool({ cwd: options.cwd, ...options.read, ...guardOf(options) });
    case "shell":
      return createShellTool({
        cwd: options.cwd,
        ...options.shell,
        ...omitUndefined({ execution: options.execution }),
      });
    case "glob":
      return createGlobTool({ cwd: options.cwd, ...omitUndefined({ execution: options.execution }) });
    case "grep":
      return createGrepTool({ cwd: options.cwd, ...omitUndefined({ execution: options.execution }) });
    case "fetch":
      return createFetchTool(options.fetch ?? {});
    case "edit":
      return createEditTool({
        cwd: options.cwd,
        ...omitUndefined({ fileFeedback: options.fileFeedback }),
        ...options.edit,
        ...guardOf(options),
      });
    case "write":
      return createWriteTool({
        cwd: options.cwd,
        ...omitUndefined({ fileFeedback: options.fileFeedback }),
        ...options.write,
        ...guardOf(options),
      });
  }
}

/** 守卫只属于文件工具；显式工具配置优先。 */
function guardOf(options: CodingToolsOptions): { guard?: WorkspaceFileGuard } {
  return omitUndefined({ guard: options.guard });
}

/** @experimental */
export function createCodingTools(options: CodingToolsOptions): Tool[] {
  return [
    createCodingTool("read", options),
    createCodingTool("shell", options),
    createCodingTool("edit", options),
    createCodingTool("write", options),
    createCodingTool("glob", options),
    createCodingTool("grep", options),
    createCodingTool("fetch", options),
  ];
}

/** @experimental */
export function createReadOnlyTools(options: CodingToolsOptions): Tool[] {
  return [createCodingTool("read", options), createCodingTool("glob", options), createCodingTool("grep", options)];
}
