import type { Tool } from "@may/core";
import type { EnvironmentProvider } from "@may/environment";
import type { WorkspaceFileGuard } from "./guard.js";
import { createEditTool, type EditToolOptions } from "./edit.js";
import { createReadTool, type ReadToolOptions } from "./read.js";
import { createShellTool, type ShellToolOptions } from "./shell.js";
import { createWriteTool, type WriteToolOptions } from "./write.js";

export type CodingToolName = "read" | "shell" | "edit" | "write";

export interface CodingToolsOptions {
  readonly environment?: EnvironmentProvider;
  readonly cwd: string;
  readonly read?: Omit<ReadToolOptions, "cwd" | "environment">;
  readonly shell?: Omit<ShellToolOptions, "cwd" | "environment">;
  readonly edit?: Omit<EditToolOptions, "cwd" | "environment">;
  readonly write?: Omit<WriteToolOptions, "cwd" | "environment">;
  /** 宿主守卫：读取、修改与写入都在同一把文件锁内完成。 */
  readonly guard?: WorkspaceFileGuard;
}

export function createCodingTool(
  name: CodingToolName,
  options: CodingToolsOptions,
): Tool {
  const environment = options.environment === undefined ? {} : { environment: options.environment };
  switch (name) {
    case "read":
      return createReadTool({ cwd: options.cwd, ...options.read, ...guardOf(options), ...environment });
    case "shell":
      return createShellTool({ cwd: options.cwd, ...options.shell, ...environment });
    case "edit":
      return createEditTool({ cwd: options.cwd, ...options.edit, ...guardOf(options), ...environment });
    case "write":
      return createWriteTool({ cwd: options.cwd, ...options.write, ...guardOf(options), ...environment });
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
