import { codingRuntimeInstructions, getShellToolInfo } from "@may/coding-tools";
import type { Tool } from "@may/core";
import type { MaybeCodeApplicationOptions } from "./application.js";

export interface MaybeCodeRuntimeEnvironment {
  readonly workspace: string;
  readonly options: MaybeCodeApplicationOptions;
  readonly historicalSource?: string;
  readonly historicalBranch: boolean;
}

export function maybeCodeRuntimeInstructions(environment: MaybeCodeRuntimeEnvironment, tools: Iterable<Tool>): string {
  const { workspace, options } = environment;
  const shell = [...tools].map(getShellToolInfo).find(info => info !== undefined);
  return codingRuntimeInstructions({
    workspace,
    ...(shell === undefined ? {} : { shell }),
    agentRole: "main agent",
    sessionOrigin: environment.historicalBranch ? "historical branch" : options.resume ? "resumed session" : "new session",
    permissionMode: options.gitWorkspace?.readOnly ? "read-only" : options.permissionModeSource?.() ?? (options.permissionPolicy ? "custom" : "default"),
    ...(environment.historicalSource === undefined ? {} : { historicalSource: environment.historicalSource }),
  });
}
