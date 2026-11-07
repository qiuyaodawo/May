import {
  DEFAULT_RUNTIME_DESCRIPTOR,
  runtimeDescriptorsEqual,
  validateRuntimeDescriptor,
  type AgentRuntime,
  type RuntimeDescriptor,
} from "../core/index.js";

export async function snapshotRuntimeState(runtime: AgentRuntime): Promise<unknown> {
  const descriptor = runtime.descriptor;
  if (descriptor === undefined || descriptor.stateVersion === undefined)
    throw new Error("Stateful runtime requires a versioned descriptor");
  validateRuntimeDescriptor(descriptor);
  const state = await runtime.saveState!();
  if (state === undefined) throw new Error("Stateful runtime must save an explicit state value");
  return structuredClone(state);
}

/** Migrate, restore and re-snapshot saved runtime state for a newly created runtime instance. */
export async function adoptRuntimeState(
  runtime: AgentRuntime,
  saved: RuntimeDescriptor,
  savedState: unknown,
): Promise<{ state: unknown; migrated: boolean }> {
  const current = runtime.descriptor ?? DEFAULT_RUNTIME_DESCRIPTOR;
  validateRuntimeDescriptor(current);
  const migrated = !runtimeDescriptorsEqual(saved, current);
  let state = savedState;
  if (migrated) {
    if (runtime.migrateState === undefined) {
      throw new Error(
        `Session runtime ${saved.id}@${saved.version} is incompatible with ${current.id}@${current.version}`,
      );
    }
    state = await runtime.migrateState(saved, state);
  }
  if (state !== undefined) {
    if (runtime.restoreState === undefined) throw new Error("Runtime cannot restore saved Session state");
    await runtime.restoreState(state);
  }
  if (runtime.saveState !== undefined) state = await snapshotRuntimeState(runtime);
  return { state, migrated };
}
