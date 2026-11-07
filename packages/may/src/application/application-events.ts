import { HookExecutionError, type HookContext, type HookDispatcher, type MayEvent } from "../core/index.js";
import type { ContextController } from "../context/index.js";
import type { PluginHost } from "../plugin/index.js";
import type { PermissionToolExecutor } from "../permissions/index.js";
import type { AgentApplicationEvent } from "./events.js";
import { applicationHooks, type InputHook } from "./hooks.js";

type ApplicationPluginScope = Awaited<ReturnType<PluginHost["createScope"]>>;

export function connectRuntimeHooks(
  sessionId: string,
  scope: () => ApplicationPluginScope,
  startBarrier: () => Promise<void> | undefined,
): HookDispatcher {
  return {
    transform: (hook, value, context) => scope().transform(hook, value, { ...context, sessionId }),
    observe: async (hook, value, context) => {
      if (hook.name === "run.before") await startBarrier();
      await scope().observe(hook, value, { ...context, sessionId });
    },
  };
}

export async function prepareInput(
  value: InputHook,
  scope: () => ApplicationPluginScope,
  context: () => HookContext,
): Promise<InputHook> {
  await scope().observe(applicationHooks.inputReceived, value, context());
  const result = await scope().transform(applicationHooks.inputBeforeSubmit, value, context());
  if (result.inputId !== value.inputId || result.steering !== value.steering) {
    throw new HookExecutionError(
      new Error("Input identity and delivery mode cannot be modified"),
      applicationHooks.inputBeforeSubmit.name,
    );
  }
  return result;
}

export async function relayRunEvents(
  events: AsyncIterable<MayEvent>,
  controller: () => ContextController | undefined,
  emit: (event: AgentApplicationEvent) => void,
): Promise<void> {
  for await (const event of events) {
    if (event.type === "model.completed" && event.usage !== undefined) {
      controller()?.recordModelUsage?.(event.usage, event.contextMessageCount);
    }
    emit({ type: "run.event", event });
  }
}

export async function relayPermissionEvents(
  permissions: PermissionToolExecutor,
  emit: (event: AgentApplicationEvent) => void,
): Promise<void> {
  for await (const event of permissions.events) emit({ type: "permission.event", event });
}
