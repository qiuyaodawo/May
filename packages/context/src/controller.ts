import type { Context, ContextSnapshot, Message, Usage } from "@may/core";

import type {
  ContextCompactionDetails,
  ContextCompactionFailure,
  ContextCompactionFailureSink,
  ContextCompactionOptions,
  ContextCompactionOutput,
  ContextCompactionResult,
  ContextCompactionSink,
  ContextCompactionStrategy,
} from "./compaction.js";
import { ContextCompactionExhaustedError } from "./compaction.js";

export interface ContextBudget {
  readonly contextWindowTokens?: number;
  readonly outputReserveTokens?: number;
  readonly toolReserveTokens?: number;
  readonly safetyMarginTokens?: number;
  readonly compactTriggerRatio?: number;
}

export interface ContextMeasurement {
  readonly inputTokens: number;
  readonly contextMessageCount: number;
}

export interface ContextInspection {
  readonly instructionsBytes: number;
  readonly messageBytes: number;
  readonly totalBytes: number;
  readonly messageCount: number;
  readonly messagesByRole: Readonly<Record<Message["role"], number>>;
  readonly toolResultCount: number;
  readonly estimatedTokens: number;
  readonly tokenEstimateMethod: "utf8-bytes/4";
  readonly effectiveTokens: number;
  readonly measurementMethod: "estimated" | "measured+estimated";
  readonly measuredInputTokens?: number;
  readonly estimatedTailTokens?: number;
  readonly contextWindowTokens?: number;
  readonly remainingTokens?: number;
  readonly usageRatio?: number;
  readonly reservedTokens?: number;
  readonly inputBudgetTokens?: number;
  readonly remainingInputTokens?: number;
  readonly compactTriggerTokens?: number;
  readonly shouldCompact?: boolean;
}

export interface ContextController {
  /** Request compaction at the next model snapshot, after the tool batch finishes. */
  requestCompaction?(strategy: ContextCompactionStrategy | undefined): void;
  /** Restore a replaced view if its checkpoint could not be persisted. */
  rollbackCompaction?(result: ContextCompactionResult): Promise<void>;
  /** Invalidate provider measurements when host instructions change. */
  invalidateMeasurement?(): void;
  inspect(): Promise<ContextInspection>;
  recordModelUsage?(usage: Usage, contextMessageCount: number): void;
  compact?(
    strategy?: ContextCompactionStrategy,
    options?: ContextCompactionOptions,
  ): Promise<ContextCompactionResult>;
  prepareForModel?(
    options?: ContextCompactionOptions,
  ): Promise<readonly ContextCompactionResult[]>;
  setAutoCompactionSink?(sink: ContextCompactionSink | undefined): void;
  setAutoCompactionFailureSink?(
    sink: ContextCompactionFailureSink | undefined,
  ): void;
}

export interface SnapshotContextControllerOptions {
  readonly budget?: ContextBudget;
  readonly measurement?: ContextMeasurement;
  readonly compactionStrategy?: ContextCompactionStrategy;
  /** Return false when expectedMessages no longer matches atomically. */
  readonly replaceMessages?: (
    messages: readonly Message[],
    expectedMessages: readonly Message[],
  ) => boolean | void | Promise<boolean | void>;
  readonly autoCompactionStrategies?: readonly ContextCompactionStrategy[];
}

export class SnapshotContextController implements ContextController {
  invalidateMeasurement(): void { this.measurement = undefined; }
  private readonly budget: ContextBudget | undefined;
  private readonly compactionStrategy: ContextCompactionStrategy | undefined;
  private readonly replaceMessages: SnapshotContextControllerOptions[
    "replaceMessages"
  ];
  private readonly autoCompactionStrategies: readonly ContextCompactionStrategy[];
  private autoCompactionSink: ContextCompactionSink | undefined;
  private autoCompactionFailureSink: ContextCompactionFailureSink | undefined;
  private measurement: ContextMeasurement | undefined;
  private compactionQueue: Promise<void> = Promise.resolve();
  private requestedCompaction: ContextCompactionStrategy | undefined;
  private readonly replacements = new WeakMap<ContextCompactionResult, {
    messages: readonly Message[];
    measurement: ContextMeasurement | undefined;
  }>();

  requestCompaction(strategy: ContextCompactionStrategy | undefined): void {
    this.requestedCompaction = strategy;
  }

  async rollbackCompaction(result: ContextCompactionResult): Promise<void> {
    const previous = this.replacements.get(result);
    if (previous === undefined) return;
    const current = await this.context.snapshot();
    const tail = appendedTail(result.messages, current.messages);
    if (tail === undefined || await this.replaceMessages!(
      [...previous.messages, ...tail], current.messages,
    ) === false) {
      throw new Error("Cannot restore context after checkpoint failure: context changed");
    }
    this.measurement = previous.measurement;
    this.replacements.delete(result);
  }

  constructor(
    private readonly context: Context,
    options: SnapshotContextControllerOptions = {},
  ) {
    this.budget = options.budget === undefined
      ? undefined
      : validateBudget(options.budget);
    this.measurement = options.measurement === undefined
      ? undefined
      : validateMeasurement(options.measurement);
    this.compactionStrategy = options.compactionStrategy;
    this.replaceMessages = options.replaceMessages;
    this.autoCompactionStrategies = [
      ...(options.autoCompactionStrategies ?? []),
    ];
  }

  async inspect(): Promise<ContextInspection> {
    return inspectContextSnapshot(await this.context.snapshot(), {
      ...(this.budget === undefined ? {} : { budget: this.budget }),
      ...(this.measurement === undefined
        ? {}
        : { measurement: this.measurement }),
    });
  }

  recordModelUsage(usage: Usage, contextMessageCount: number): void {
    if (usage.inputTokens === undefined) return;
    this.measurement = validateMeasurement({
      inputTokens: usage.inputTokens,
      contextMessageCount,
    });
  }

  setAutoCompactionSink(sink: ContextCompactionSink | undefined): void {
    this.autoCompactionSink = sink;
  }

  setAutoCompactionFailureSink(
    sink: ContextCompactionFailureSink | undefined,
  ): void {
    this.autoCompactionFailureSink = sink;
  }

  async prepareForModel(
    options: ContextCompactionOptions = {},
  ): Promise<readonly ContextCompactionResult[]> {
    const requested = this.requestedCompaction;
    const strategies = requested === undefined ? this.autoCompactionStrategies : [requested];
    if (strategies.length === 0) return [];
    throwIfAborted(options.signal);

    const snapshot = await this.context.snapshot();
    const inspection = inspectContextSnapshot(
      snapshot,
      this.inspectionOptions(),
    );
    if (requested === undefined && inspection.shouldCompact !== true) return [];

    const results: ContextCompactionResult[] = [];
    const failures: ContextCompactionFailure[] = [];
    let currentInspection = inspection;
    for (const [index, strategy] of strategies.entries()) {
      let result: ContextCompactionResult;
      try {
        result = await this.compact(strategy, options);
      } catch (error) {
        throwIfAborted(options.signal);
        if (isAbortError(error)) throw error;
        const failure: ContextCompactionFailure = {
          strategy: strategy.name,
          error: normalizeError(error),
          before: currentInspection,
          continuing: index < strategies.length - 1,
        };
        failures.push(failure);
        await this.autoCompactionFailureSink?.(failure);
        if (requested !== undefined) throw error;
        continue;
      }
      currentInspection = result.after;
      if (result.changed) {
        try {
          await this.autoCompactionSink?.(result, options);
        } catch (error) {
          await this.rollbackCompaction(result);
          throw error;
        }
        results.push(result);
      }
      if (result.terminal === true || currentInspection.shouldCompact !== true) {
        break;
      }
    }

    if (this.requestedCompaction === requested) this.requestedCompaction = undefined;

    if (currentInspection.shouldCompact === true) {
      currentInspection = await this.inspect();
    }
    if (currentInspection.shouldCompact === true) {
      throw new ContextCompactionExhaustedError(currentInspection, failures);
    }
    return results;
  }

  compact(
    strategy = this.compactionStrategy,
    options: ContextCompactionOptions = {},
  ): Promise<ContextCompactionResult> {
    const result = this.compactionQueue.then(() =>
      this.compactExclusive(strategy, options)
    );
    this.compactionQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async compactExclusive(
    strategy: ContextCompactionStrategy | undefined,
    options: ContextCompactionOptions,
  ): Promise<ContextCompactionResult> {
    throwIfAborted(options.signal);
    if (strategy === undefined) {
      throw new Error("No context compaction strategy is configured");
    }
    if (strategy.name.trim() === "") {
      throw new Error("Context compaction strategy name cannot be empty");
    }
    if (this.replaceMessages === undefined) {
      throw new Error("The active context does not support compaction");
    }

    let sourceSnapshot = await this.context.snapshot();
    let before = inspectContextSnapshot(
      sourceSnapshot,
      this.inspectionOptions(),
    );

    while (true) {
      const output = normalizeCompactionOutput(await strategy.compact(
        {
          ...sourceSnapshot,
          messages: [...sourceSnapshot.messages],
        },
        options,
      ));
      throwIfAborted(options.signal);

      while (true) {
        const latestSnapshot = await this.context.snapshot();
        throwIfAborted(options.signal);
        const tail = appendedTail(sourceSnapshot.messages, latestSnapshot.messages);
        if (tail === undefined) {
          // Another replacement won the race. Re-run the strategy against that
          // history instead of overwriting it with a stale result.
          sourceSnapshot = latestSnapshot;
          before = inspectContextSnapshot(
            sourceSnapshot,
            this.inspectionOptions(),
          );
          break;
        }

        const compactedMessages = [...output.messages];
        const messages = [...compactedMessages, ...tail];
        const changed = !messagesEqual(messages, latestSnapshot.messages);
        if (!changed) {
          if (output.effectiveTokens !== undefined) {
            this.applyCompactionMeasurement(
              output.effectiveTokens,
              compactedMessages.length,
            );
          }
          const after = inspectContextSnapshot(
            latestSnapshot,
            this.inspectionOptions(),
          );
          return {
            strategy: strategy.name,
            changed,
            messages,
            before,
            after,
            ...(output.terminal === true ? { terminal: true } : {}),
          };
        }

        const replaced = await this.replaceMessages(
          messages,
          latestSnapshot.messages,
        );
        if (replaced === false) continue;

        const previousMeasurement = this.measurement;
        this.applyCompactionMeasurement(
          output.effectiveTokens,
          compactedMessages.length,
        );
        const afterSnapshot = await this.context.snapshot();
        const after = inspectContextSnapshot(
          afterSnapshot,
          this.inspectionOptions(),
        );
        const result: ContextCompactionResult = {
          strategy: strategy.name,
          changed,
          messages: [...afterSnapshot.messages],
          before,
          after,
          ...(output.terminal === true ? { terminal: true } : {}),
        };
        this.replacements.set(result, { messages: latestSnapshot.messages, measurement: previousMeasurement });
        return result;
      }
    }
  }

  private applyCompactionMeasurement(
    effectiveTokens: number | undefined,
    compactedMessageCount: number,
  ): void {
    this.measurement = effectiveTokens === undefined
      ? undefined
      : validateMeasurement({
          inputTokens: effectiveTokens,
          contextMessageCount: compactedMessageCount,
        });
  }

  private inspectionOptions(): {
    budget?: ContextBudget;
    measurement?: ContextMeasurement;
  } {
    return {
      ...(this.budget === undefined ? {} : { budget: this.budget }),
      ...(this.measurement === undefined
        ? {}
        : { measurement: this.measurement }),
    };
  }
}

function appendedTail(
  source: readonly Message[],
  latest: readonly Message[],
): readonly Message[] | undefined {
  if (latest.length < source.length) return undefined;
  for (let index = 0; index < source.length; index++) {
    if (!messagesEqual([source[index]!], [latest[index]!])) return undefined;
  }
  return latest.slice(source.length);
}

function messagesEqual(
  left: readonly Message[],
  right: readonly Message[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeCompactionOutput(
  output: ContextCompactionOutput,
): ContextCompactionDetails {
  if (Array.isArray(output)) return { messages: output };
  if (
    typeof output !== "object" ||
    output === null ||
    !("messages" in output) ||
    !Array.isArray(output.messages)
  ) {
    throw new TypeError("Context compaction strategy must return messages");
  }
  if (
    output.effectiveTokens !== undefined &&
    (!Number.isSafeInteger(output.effectiveTokens) || output.effectiveTokens < 0)
  ) {
    throw new RangeError("effectiveTokens must be a non-negative safe integer");
  }
  if (output.terminal !== undefined && typeof output.terminal !== "boolean") {
    throw new TypeError("terminal must be a boolean");
  }
  return {
    messages: output.messages,
    ...(output.effectiveTokens === undefined
      ? {}
      : { effectiveTokens: output.effectiveTokens }),
    ...(output.terminal === undefined ? {} : { terminal: output.terminal }),
  };
}

export function inspectContextSnapshot(
  snapshot: ContextSnapshot,
  options: {
    readonly budget?: ContextBudget;
    readonly measurement?: ContextMeasurement;
  } = {},
): ContextInspection {
  const budget = options.budget === undefined
    ? undefined
    : validateBudget(options.budget);
  const measurement = options.measurement === undefined
    ? undefined
    : validateMeasurement(options.measurement);
  const messagesByRole: Record<Message["role"], number> = {
    system: 0,
    user: 0,
    assistant: 0,
    tool: 0,
  };
  let messageBytes = 0;

  for (const message of snapshot.messages) {
    messagesByRole[message.role] += 1;
    messageBytes += utf8Bytes(JSON.stringify(message));
  }

  const instructionsBytes = utf8Bytes(snapshot.instructions ?? "");
  const totalBytes = instructionsBytes + messageBytes;
  const estimatedTokens = Math.ceil(totalBytes / 4);
  let effectiveTokens = estimatedTokens;
  let measurementDetails: Pick<
    ContextInspection,
    "measurementMethod"
  > | Pick<
    ContextInspection,
    "measurementMethod" | "measuredInputTokens" | "estimatedTailTokens"
  > = { measurementMethod: "estimated" };
  if (
    measurement !== undefined &&
    measurement.contextMessageCount <= snapshot.messages.length
  ) {
    const estimatedTailTokens = estimateMessageTokens(
      snapshot.messages.slice(measurement.contextMessageCount),
    );
    effectiveTokens = measurement.inputTokens + estimatedTailTokens;
    measurementDetails = {
      measurementMethod: "measured+estimated",
      measuredInputTokens: measurement.inputTokens,
      estimatedTailTokens,
    };
  }
  const budgetDetails: Pick<
    ContextInspection,
    | "contextWindowTokens"
    | "remainingTokens"
    | "usageRatio"
    | "reservedTokens"
    | "inputBudgetTokens"
    | "remainingInputTokens"
    | "compactTriggerTokens"
    | "shouldCompact"
  > | Record<string, never> = budget?.contextWindowTokens === undefined
    ? {}
    : createBudgetInspection(
      budget,
      budget.contextWindowTokens,
      effectiveTokens,
    );
  return {
    instructionsBytes,
    messageBytes,
    totalBytes,
    messageCount: snapshot.messages.length,
    messagesByRole,
    toolResultCount: messagesByRole.tool,
    estimatedTokens,
    tokenEstimateMethod: "utf8-bytes/4",
    effectiveTokens,
    ...measurementDetails,
    ...budgetDetails,
  };
}

function createBudgetInspection(
  budget: ContextBudget,
  contextWindowTokens: number,
  effectiveTokens: number,
): Pick<
  ContextInspection,
  | "contextWindowTokens"
  | "remainingTokens"
  | "usageRatio"
  | "reservedTokens"
  | "inputBudgetTokens"
  | "remainingInputTokens"
  | "compactTriggerTokens"
  | "shouldCompact"
> {
  const reservedTokens = (budget.outputReserveTokens ?? 0) +
    (budget.toolReserveTokens ?? 0) +
    (budget.safetyMarginTokens ?? 0);
  const inputBudgetTokens = Math.max(
    0,
    contextWindowTokens - reservedTokens,
  );
  const triggerTokens = budget.compactTriggerRatio === undefined
    ? undefined
    : Math.floor(Math.min(
      contextWindowTokens * budget.compactTriggerRatio,
      inputBudgetTokens,
    ));
  return {
    contextWindowTokens,
    remainingTokens: Math.max(
      0,
      contextWindowTokens - effectiveTokens,
    ),
    usageRatio: effectiveTokens / contextWindowTokens,
    reservedTokens,
    inputBudgetTokens,
    remainingInputTokens: Math.max(0, inputBudgetTokens - effectiveTokens),
    ...(triggerTokens === undefined
      ? {}
      : {
          compactTriggerTokens: triggerTokens,
          shouldCompact: effectiveTokens >= triggerTokens,
        }),
  };
}

function estimateMessageTokens(messages: readonly Message[]): number {
  let bytes = 0;
  for (const message of messages) bytes += utf8Bytes(JSON.stringify(message));
  return Math.ceil(bytes / 4);
}

function validateBudget(budget: ContextBudget): ContextBudget {
  validateOptionalInteger(
    budget.contextWindowTokens,
    "contextWindowTokens",
    1,
  );
  validateOptionalInteger(budget.outputReserveTokens, "outputReserveTokens", 0);
  validateOptionalInteger(budget.toolReserveTokens, "toolReserveTokens", 0);
  validateOptionalInteger(
    budget.safetyMarginTokens,
    "safetyMarginTokens",
    0,
  );
  if (
    budget.compactTriggerRatio !== undefined &&
    (!Number.isFinite(budget.compactTriggerRatio) ||
      budget.compactTriggerRatio <= 0 ||
      budget.compactTriggerRatio >= 1)
  ) {
    throw new RangeError("compactTriggerRatio must be greater than 0 and less than 1");
  }
  return { ...budget };
}

function validateMeasurement(
  measurement: ContextMeasurement,
): ContextMeasurement {
  validateInteger(measurement.inputTokens, "inputTokens", 0);
  validateInteger(
    measurement.contextMessageCount,
    "contextMessageCount",
    0,
  );
  return { ...measurement };
}

function validateOptionalInteger(
  value: number | undefined,
  name: string,
  minimum: number,
): void {
  if (value !== undefined) validateInteger(value, name, minimum);
}

function validateInteger(value: number, name: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(
      `${name} must be a safe integer greater than or equal to ${minimum}`,
    );
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const error = new Error(
    typeof signal.reason === "string" ? signal.reason : "Context compaction cancelled",
  );
  error.name = "AbortError";
  throw error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}
