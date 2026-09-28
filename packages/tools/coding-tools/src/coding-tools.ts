import type { Tool } from "@may/core";
import type { WorkspaceFileGuard } from "./guard.js";
import { createEditTool, type EditToolOptions } from "./edit.js";
import { createReadTool, type ReadToolOptions } from "./read.js";
import { createShellTool, type ShellToolOptions } from "./shell.js";
import { createWriteTool, type WriteToolOptions } from "./write.js";

export type CodingToolName = "read" | "shell" | "edit" | "write";

export interface CodingToolsOptions {
  readonly cwd: string;
  readonly read?: Omit<ReadToolOptions, "cwd">;
  readonly shell?: Omit<ShellToolOptions, "cwd">;
  readonly edit?: Omit<EditToolOptions, "cwd">;
  readonly write?: Omit<WriteToolOptions, "cwd">;
  /** 宿主守卫：读取、修改与写入都在同一把文件锁内完成。 */
  readonly guard?: WorkspaceFileGuard;
}

export function createCodingTool(
  name: CodingToolName,
  options: CodingToolsOptions,
): Tool {
  switch (name) {
    case "read":
      return createReadTool({ cwd: options.cwd, ...options.read, ...guardOf(options) });
    case "shell":
      return createShellTool({ cwd: options.cwd, ...options.shell });
    case "edit":
      return createEditTool({ cwd: options.cwd, ...options.edit, ...guardOf(options) });
    case "write":
      return createWriteTool({ cwd: options.cwd, ...options.write, ...guardOf(options) });
  }
}

/** 守卫只属于文件工具；显式工具配置优先。 */
function guardOf(options: CodingToolsOptions): { guard?: WorkspaceFileGuard } {
  return options.guard === undefined ? {} : { guard: options.guard };
}

export function createCodingTools(options: CodingToolsOptions): Tool[] {
  return [
    createCodingTool("read", options),
    createCodingTool("shell", options),
    createCodingTool("edit", options),
    createCodingTool("write", options),
  ];
}

export function createReadOnlyTools(options: CodingToolsOptions): Tool[] {
  return [createCodingTool("read", options)];
}
