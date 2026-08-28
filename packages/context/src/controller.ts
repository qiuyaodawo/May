import type { Context, ContextSnapshot, Message, Usage } from "@may/core";

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
}

export interface ContextController {
  inspect(): Promise<ContextInspection>;
  recordModelUsage?(usage: Usage, contextMessageCount: number): void;
}

export class SnapshotContextController implements ContextController {
  private readonly budget: ContextBudget | undefined;
  private measurement: ContextMeasurement | undefined;

  constructor(
    private readonly context: Context,
    options: {
      readonly budget?: ContextBudget;
      readonly measurement?: ContextMeasurement;
    } = {},
  ) {
    this.budget = options.budget === undefined
      ? undefined
      : validateBudget(options.budget);
    this.measurement = options.measurement === undefined
      ? undefined
      : validateMeasurement(options.measurement);
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
    "contextWindowTokens" | "remainingTokens" | "usageRatio"
  > | Record<string, never> = budget?.contextWindowTokens === undefined
    ? {}
    : {
        contextWindowTokens: budget.contextWindowTokens,
        remainingTokens: Math.max(
          0,
          budget.contextWindowTokens - effectiveTokens,
        ),
        usageRatio: effectiveTokens / budget.contextWindowTokens,
      };
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
