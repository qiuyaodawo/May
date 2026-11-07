import { May, type ContinueOptions, type MayOptions, type RunHandle, type RunOptions } from "./may.js";
import type { HookDefinition } from "./hooks.js";
import type { Message } from "./types.js";

/** @experimental */
export interface RuntimeDescriptor {
  readonly id: string;
  readonly version: string;
  readonly stateVersion?: number;
}

/** @experimental */
export interface AgentRuntime {
  readonly supportsRequestRecording?: boolean;
  readonly descriptor?: RuntimeDescriptor;
  readonly supportedHooks?: readonly HookDefinition<unknown>[];
  run(options: RunOptions): RunHandle;
  continue(options?: ContinueOptions): RunHandle;
  appendMessages(messages: Message[]): Promise<void>;
  saveState?(): unknown | Promise<unknown>;
  restoreState?(state: unknown): void | Promise<void>;
  migrateState?(saved: RuntimeDescriptor, state: unknown): unknown | Promise<unknown>;
  close?(): void | Promise<void>;
}

/** @experimental */
export type RuntimeFactory = (options: MayOptions) => AgentRuntime | Promise<AgentRuntime>;

/** @experimental */
export const DEFAULT_RUNTIME_DESCRIPTOR: RuntimeDescriptor = Object.freeze({ id: "may", version: "1" });

/** @experimental */
export const defaultRuntimeFactory: RuntimeFactory = (options) => new May(options);

/** @experimental */
export function validateRuntimeDescriptor(value: RuntimeDescriptor): void {
  if (typeof value.id !== "string" || value.id.trim() === "") throw new TypeError("Runtime id cannot be empty");
  if (typeof value.version !== "string" || value.version.trim() === "")
    throw new TypeError("Runtime version cannot be empty");
  if (value.stateVersion !== undefined && (!Number.isSafeInteger(value.stateVersion) || value.stateVersion < 1))
    throw new TypeError("Runtime stateVersion must be a positive safe integer");
}

/** @experimental */
export function runtimeDescriptorsEqual(left: RuntimeDescriptor, right: RuntimeDescriptor): boolean {
  return left.id === right.id && left.version === right.version && left.stateVersion === right.stateVersion;
}
