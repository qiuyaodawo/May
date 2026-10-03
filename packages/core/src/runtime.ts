import { May, type ContinueOptions, type MayOptions, type RunHandle, type RunOptions } from "./may.js";
import type { HookDefinition } from "./hooks.js";
import type { Message } from "./types.js";

export interface RuntimeDescriptor {
  readonly id: string;
  readonly version: string;
  readonly stateVersion?: number;
}

export interface AgentRuntime {
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

export type RuntimeFactory = (options: MayOptions) => AgentRuntime | Promise<AgentRuntime>;

export const DEFAULT_RUNTIME_DESCRIPTOR: RuntimeDescriptor = Object.freeze({ id: "may", version: "1" });

export const defaultRuntimeFactory: RuntimeFactory = (options) => new May(options);

export function validateRuntimeDescriptor(value: RuntimeDescriptor): void {
  if (typeof value.id !== "string" || value.id.trim() === "") throw new TypeError("Runtime id cannot be empty");
  if (typeof value.version !== "string" || value.version.trim() === "") throw new TypeError("Runtime version cannot be empty");
  if (value.stateVersion !== undefined && (!Number.isSafeInteger(value.stateVersion) || value.stateVersion < 1)) throw new TypeError("Runtime stateVersion must be a positive safe integer");
}

export function assertRuntimeCompatible(saved: RuntimeDescriptor, runtime: AgentRuntime): void {
  validateRuntimeDescriptor(saved);
  const current = runtime.descriptor ?? DEFAULT_RUNTIME_DESCRIPTOR;
  validateRuntimeDescriptor(current);
  if (!runtimeDescriptorsEqual(saved, current)) {
    throw new Error(`Session runtime ${saved.id}@${saved.version} is incompatible with ${current.id}@${current.version}`);
  }
}

export function runtimeDescriptorsEqual(left: RuntimeDescriptor, right: RuntimeDescriptor): boolean {
  validateRuntimeDescriptor(left);
  validateRuntimeDescriptor(right);
  return left.id === right.id && left.version === right.version && left.stateVersion === right.stateVersion;
}
