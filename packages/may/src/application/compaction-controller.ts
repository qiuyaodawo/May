import type {
  ContextBudget,
  ContextCompactionOptions,
  ContextCompactionResult,
  ContextCompactionStrategy,
  ContextController,
} from "../context/index.js";
import { omitUndefined, serializeError, type HookContext, type Model } from "../core/index.js";
import type { PluginHost } from "../plugin/index.js";
import type { Session } from "../session/index.js";
import { applicationHooks } from "./hooks.js";

export async function performCompaction(
  strategy: ContextCompactionStrategy | undefined,
  signal: AbortSignal,
  scope: Awaited<ReturnType<PluginHost["createScope"]>>,
  context: () => HookContext,
  controller: () => ContextController,
  persist: (result: ContextCompactionResult) => Promise<void>,
): Promise<ContextCompactionResult> {
  try {
    const selection = await scope.transform(
      applicationHooks.compactionBefore,
      omitUndefined({ strategy: strategy?.name, automatic: false }),
      context(),
    );
    if (selection.strategy !== strategy?.name)
      throw new Error(`Unsupported compaction strategy: ${selection.strategy}`);
    const result = await controller().compact!(strategy, { signal });
    if (result.changed) {
      try {
        await persist(result);
        controller().commitCompaction?.(result);
      } catch (error) {
        await controller().rollbackCompaction?.(result);
        throw error;
      }
    }
    await scope.observe(applicationHooks.compactionCompleted, { ...result, automatic: false }, context());
    return result;
  } catch (error) {
    await scope.observe(
      applicationHooks.compactionFailed,
      omitUndefined({ strategy: strategy?.name, automatic: false, error: serializeError(error) }),
      context(),
    );
    throw error;
  }
}

export function persistCompaction(
  session: Session,
  result: ContextCompactionResult,
  ordering?: Pick<ContextCompactionOptions, "runId" | "step">,
): Promise<void> {
  const afterRunStep =
    ordering?.runId === undefined || ordering.step === undefined
      ? undefined
      : { runId: ordering.runId, step: ordering.step };
  return session.recordContextCompaction(
    {
      strategy: result.strategy,
      messages: result.messages,
      beforeMessageCount: result.before.messageCount,
      afterMessageCount: result.after.messageCount,
      beforeEstimatedTokens: result.before.estimatedTokens,
      afterEstimatedTokens: result.after.estimatedTokens,
    },
    afterRunStep,
  );
}

/** Derive context capacity from provider-neutral model limits.
 * @experimental
 */
export function contextBudgetFromModel(model: Model): ContextBudget | undefined {
  if (model.limits === undefined) return undefined;
  return omitUndefined({
    contextWindowTokens: model.limits.contextWindowTokens,
    outputReserveTokens: model.limits.maxOutputTokens,
  });
}

/** Add a default automatic-compaction threshold without overriding callers.
 * @experimental
 */
export function withDefaultCompactionThreshold(
  budget: ContextBudget | undefined,
  compactTriggerRatio = 0.9,
): ContextBudget | undefined {
  if (budget?.contextWindowTokens === undefined) return budget;
  if (budget.compactTriggerRatio !== undefined) return budget;
  if (!Number.isFinite(compactTriggerRatio) || compactTriggerRatio <= 0 || compactTriggerRatio >= 1) {
    throw new RangeError("compactTriggerRatio must be greater than 0 and less than 1");
  }
  return { ...budget, compactTriggerRatio };
}
