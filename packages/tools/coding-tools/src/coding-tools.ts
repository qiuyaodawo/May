import type { Tool } from "@may/core";
import { createBashTool, type BashToolOptions } from "./bash.js";
import { createEditTool, type EditToolOptions } from "./edit.js";
import { createReadTool, type ReadToolOptions } from "./read.js";
import { createWriteTool, type WriteToolOptions } from "./write.js";

export type CodingToolName = "read" | "bash" | "edit" | "write";

export interface CodingToolsOptions {
  readonly cwd: string;
  readonly read?: Omit<ReadToolOptions, "cwd">;
  readonly bash?: Omit<BashToolOptions, "cwd">;
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
    case "bash":
      return createBashTool({ cwd: options.cwd, ...options.bash });
    case "edit":
      return createEditTool({ cwd: options.cwd, ...options.edit });
    case "write":
      return createWriteTool({ cwd: options.cwd, ...options.write });
  }
}

export function createCodingTools(options: CodingToolsOptions): Tool[] {
  return [
    createCodingTool("read", options),
    createCodingTool("bash", options),
    createCodingTool("edit", options),
    createCodingTool("write", options),
  ];
}

export function createReadOnlyTools(options: CodingToolsOptions): Tool[] {
  return [createCodingTool("read", options)];
}
