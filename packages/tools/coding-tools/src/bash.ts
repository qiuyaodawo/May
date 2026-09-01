import type { Tool } from "@may/core";
import {
  createBashShellProfile,
  createShellTool,
  type ShellToolInput,
  type ShellToolOptions,
  type ShellToolOutput,
} from "./shell.js";

/** @deprecated Prefer the cross-platform `createShellTool`. */
export interface BashToolOptions extends Omit<ShellToolOptions, "profile"> {
  readonly executable?: string;
}

/** @deprecated Use `ShellToolInput`. */
export type BashToolInput = ShellToolInput;
/** @deprecated Use `ShellToolOutput`. */
export type BashToolOutput = ShellToolOutput;

/**
 * Create a tool that explicitly requires Bash. On Windows this requires a
 * Bash executable such as Git Bash to be available or configured.
 *
 * @deprecated Prefer `createShellTool`, which selects PowerShell on Windows.
 */
export function createBashTool(options: BashToolOptions): Tool<
  BashToolInput,
  BashToolOutput
> {
  const { executable, ...shellOptions } = options;
  const tool = createShellTool({
    ...shellOptions,
    profile: createBashShellProfile({
      ...(executable === undefined ? {} : { executable }),
    }),
  });
  return {
    ...tool,
    name: "bash",
    description: "Execute a Bash command in the workspace. Use Bash syntax. " +
      "This is not a sandbox.",
  };
}
