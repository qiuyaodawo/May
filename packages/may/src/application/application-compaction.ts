import type {
  ContextCompactionFailure,
  ContextCompactionOptions,
  ContextCompactionResult,
  ContextCompactionStrategy,
  ContextController,
} from "../context/index.js";
import {
  endTraceSpan,
  omitUndefined,
  serializeError,
  startTraceSpan,
  traceError,
  type HookContext,
  type Tracer,
} from "../core/index.js";
import type { PluginHost } from "../plugin/index.js";
import type { Session } from "../session/index.js";
import type { AgentApplicationEvent } from "./events.js";
import { applicationHooks } from "./hooks.js";
import { performCompaction, persistCompaction } from "./compaction-controller.js";

type ApplicationPluginScope = Awaited<ReturnType<PluginHost["createScope"]>>;

export type ActiveCompaction = ReturnType<typeof startCompaction>;

export function assertCompactionAvailable(running: boolean, controller: ContextController | undefined): void {
  if (running) throw new Error("Cannot compact context while an operation is active");
  if (controller?.compact === undefined) throw new Error("Context compaction is not supported by the active context");
}

export async function awaitCompaction(active: ActiveCompaction, release: () => void): Promise<ContextCompactionResult> {
  try {
    return await active.result;
  } finally {
    release();
  }
}

export function startCompaction(
  strategy: ContextCompactionStrategy | undefined,
  session: Session,
  scope: ApplicationPluginScope,
  context: (signal: AbortSignal) => HookContext,
  readController: () => ContextController,
  tracer: Tracer | undefined,
) {
  const controller = new AbortController();
  const span = startTraceSpan(tracer, "may.context.compact", {
    attributes: omitUndefined({
      "may.session.id": session.id,
      "may.context.compaction.strategy": strategy?.name,
    }),
  });
  const operation = performCompaction(
    strategy,
    controller.signal,
    scope,
    () => context(controller.signal),
    readController,
    (result) => persistCompaction(session, result),
  ).then(
    (result) => {
      endTraceSpan(span, {
        status: "ok",
        attributes: {
          "may.context.compaction.strategy": result.strategy,
          "may.context.compaction.changed": result.changed,
          "may.context.before_message_count": result.before.messageCount,
          "may.context.after_message_count": result.after.messageCount,
          "may.context.before_estimated_tokens": result.before.estimatedTokens,
          "may.context.after_estimated_tokens": result.after.estimatedTokens,
        },
      });
      return result;
    },
    (error: unknown) => {
      endTraceSpan(span, {
        status: controller.signal.aborted ? "cancelled" : "error",
        error: traceError(error),
      });
      throw error;
    },
  );
  return { controller, result: operation };
}

export async function recordAutomaticCompaction(
  result: ContextCompactionResult,
  options: ContextCompactionOptions,
  session: Session,
  readController: () => ContextController | undefined,
  scope: () => ApplicationPluginScope,
  context: () => HookContext,
  emit: (event: AgentApplicationEvent) => void,
): Promise<void> {
  await persistCompaction(session, result, options);
  readController()?.commitCompaction?.(result);
  await scope().observe(applicationHooks.compactionCompleted, { ...result, automatic: true }, context());
  emit({ type: "context.compacted", strategy: result.strategy, before: result.before, after: result.after });
}

export async function recordAutomaticCompactionFailure(
  failure: ContextCompactionFailure,
  scope: ApplicationPluginScope,
  context: HookContext,
  emit: (event: AgentApplicationEvent) => void,
): Promise<void> {
  await scope.observe(
    applicationHooks.compactionFailed,
    { strategy: failure.strategy, automatic: true, error: serializeError(failure.error) },
    context,
  );
  emit({
    type: "context.compaction.failed",
    strategy: failure.strategy,
    automatic: true,
    error: serializeError(failure.error),
    continuing: failure.continuing,
    before: failure.before,
  });
}
