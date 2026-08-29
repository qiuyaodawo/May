import {
  serializeError,
  type Model,
  type ModelContextCompactor,
  type ModelEvent,
  type ModelLimits,
  type ModelRequest,
} from "@may/core";

const RETRYABLE_STATUSES = new Set([408, 409, 429]);
const RETRYABLE_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const RETRYABLE_PROVIDER_TYPES = new Set([
  "api_error",
  "internal_error",
  "overloaded_error",
  "rate_limit_error",
  "server_error",
]);

export interface ModelRetryContext {
  /** The attempt that just failed (one-based). */
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly signal: AbortSignal;
}

export interface RetryingModelOptions {
  /** Total attempts, including the initial request. Defaults to 3. */
  readonly maxAttempts?: number;
  /** Delay before the second attempt. Defaults to 500ms. */
  readonly baseDelayMs?: number;
  /** Upper bound for calculated delays. Defaults to 8 seconds. */
  readonly maxDelayMs?: number;
  /** Random variation applied to calculated delays. Defaults to 0.2. */
  readonly jitterRatio?: number;
  readonly shouldRetry?: (
    error: unknown,
    context: ModelRetryContext,
  ) => boolean;
  /** Test or host hook for delay scheduling. */
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  /** Test or host hook for jitter. Must return a value from 0 through 1. */
  readonly random?: () => number;
}

/**
 * Retries one model request at a time. It never wraps an entire agent run, so
 * completed tool calls are not replayed when a later model request fails.
 */
export class RetryingModel implements Model {
  readonly limits?: ModelLimits;
  readonly contextCompactor?: ModelContextCompactor;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitterRatio: number;
  private readonly shouldRetry: NonNullable<RetryingModelOptions["shouldRetry"]>;
  private readonly sleep: NonNullable<RetryingModelOptions["sleep"]>;
  private readonly random: NonNullable<RetryingModelOptions["random"]>;

  constructor(
    private readonly model: Model,
    options: RetryingModelOptions = {},
  ) {
    if (model.limits !== undefined) this.limits = model.limits;
    if (model.contextCompactor !== undefined) {
      this.contextCompactor = model.contextCompactor;
    }
    this.maxAttempts = positiveInteger(options.maxAttempts ?? 3, "maxAttempts");
    this.baseDelayMs = nonNegativeNumber(options.baseDelayMs ?? 500, "baseDelayMs");
    this.maxDelayMs = nonNegativeNumber(options.maxDelayMs ?? 8_000, "maxDelayMs");
    if (this.baseDelayMs > this.maxDelayMs) {
      throw new RangeError("baseDelayMs cannot exceed maxDelayMs");
    }
    this.jitterRatio = ratio(options.jitterRatio ?? 0.2, "jitterRatio");
    this.shouldRetry = options.shouldRetry ?? defaultShouldRetryModelError;
    this.sleep = options.sleep ?? abortableSleep;
    this.random = options.random ?? Math.random;
  }

  async *stream(
    request: ModelRequest,
    options: { signal: AbortSignal },
  ): AsyncIterable<ModelEvent> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let completed = false;
      try {
        for await (const event of this.model.stream(request, options)) {
          if (options.signal.aborted) throw abortReason(options.signal);
          yield event;
          if (event.type === "response.completed") completed = true;
        }
        return;
      } catch (error) {
        const context: ModelRetryContext = {
          attempt,
          maxAttempts: this.maxAttempts,
          signal: options.signal,
        };
        if (
          options.signal.aborted ||
          completed ||
          attempt >= this.maxAttempts ||
          !this.shouldRetry(error, context)
        ) {
          throw error;
        }

        const delayMs = this.retryDelay(error, attempt);
        yield {
          type: "retrying",
          attempt: attempt + 1,
          maxAttempts: this.maxAttempts,
          delayMs,
          error: serializeError(error),
        };
        await this.sleep(delayMs, options.signal);
      }
    }
  }

  private retryDelay(error: unknown, failedAttempt: number): number {
    const requested = retryAfterMs(error);
    if (requested !== undefined) return Math.min(requested, this.maxDelayMs);

    const exponential = Math.min(
      this.baseDelayMs * 2 ** (failedAttempt - 1),
      this.maxDelayMs,
    );
    if (exponential === 0 || this.jitterRatio === 0) return exponential;

    const random = this.random();
    if (!Number.isFinite(random) || random < 0 || random > 1) {
      throw new RangeError("random must return a number from 0 through 1");
    }
    const factor = 1 - this.jitterRatio + random * this.jitterRatio * 2;
    return Math.round(Math.min(exponential * factor, this.maxDelayMs));
  }
}

export function withModelRetry(
  model: Model,
  options: RetryingModelOptions = {},
): Model {
  return new RetryingModel(model, options);
}

export function defaultShouldRetryModelError(error: unknown): boolean {
  return classifyRetryable(error, new Set());
}

function classifyRetryable(error: unknown, seen: Set<unknown>): boolean {
  if (typeof error !== "object" || error === null || seen.has(error)) return false;
  seen.add(error);

  const candidate = error as Record<string, unknown>;
  if (candidate.name === "AbortError" || candidate.name === "RunCancelledError") {
    return false;
  }

  const status = candidate.status;
  if (typeof status === "number") {
    return RETRYABLE_STATUSES.has(status) || status >= 500;
  }

  for (const value of [candidate.code, candidate.errno]) {
    if (typeof value === "string" && RETRYABLE_CODES.has(value.toUpperCase())) {
      return true;
    }
  }

  if (
    typeof candidate.providerType === "string" &&
    RETRYABLE_PROVIDER_TYPES.has(candidate.providerType.toLowerCase())
  ) {
    return true;
  }
  if (candidate.name === "TimeoutError") return true;
  if (
    candidate.name === "TypeError" &&
    typeof candidate.message === "string" &&
    /fetch|network|socket|timed?\s*out/i.test(candidate.message)
  ) {
    return true;
  }

  return classifyRetryable(candidate.cause, seen);
}

function retryAfterMs(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  if (delayMs === 0) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException(
    typeof signal.reason === "string" ? signal.reason : "The operation was aborted",
    "AbortError",
  );
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeNumber(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative finite number`);
  }
  return value;
}

function ratio(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${field} must be a number from 0 through 1`);
  }
  return value;
}
