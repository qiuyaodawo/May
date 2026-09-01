import type { Tool } from "@may/core";
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
}

export function createCodingTool(
  name: CodingToolName,
  options: CodingToolsOptions,
): Tool {
  switch (name) {
    case "read":
      return createReadTool({ cwd: options.cwd, ...options.read });
    case "shell":
      return createShellTool({ cwd: options.cwd, ...options.shell });
    case "edit":
      return createEditTool({ cwd: options.cwd, ...options.edit });
    case "write":
      return createWriteTool({ cwd: options.cwd, ...options.write });
  }
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
