import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Model, ModelEvent, ModelStreamOptions, SerializedError } from "@may/core";
import { ModelResponseValidationError, priceUsage, type UsageCost } from "@may/core";
import {
  FileSharedBudget,
  type ExternalCallResult,
  type SharedBudgetLimits,
  type SharedBudgetSnapshot,
  type SharedBudgetTotals,
} from "@may/coordination";

export interface SubagentBudgetLimits extends SharedBudgetLimits {
  /**
   * 单次调用预留的 token 数。
   *
   * 它既是并发预留的额度，也是无法取得 usage 时的保守计账值。没有配置 token 上限时，
   * 已报告的实际 token 用量超过预留额度不会阻塞后续调用；没有上报 usage 的模型调用
   * 记为 unknown，并阻止后续调用。
   */
  readonly reservationTokens: number;
}

/**
 * 一次用户请求的共享额度账本，覆盖主 Agent、子 Agent 与 provider 原生压缩。
 *
 * Goal 与 steering 的 Run 同样是一次请求，因此也经过本账本。
 *
 * 保证范围：
 * - 模型调用在发出前原子预留并写入账本，因此并发调用与多 step 都不能越过调用次数上限；
 * - provider 自动重试的每一次真实尝试都是一次独立的预留：`retrying` 事件在下一 attempt
 *   发出之前到达账本包装，包装先把失败的那次尝试记为 unknown，再预留下一 attempt；
 *   额度不足时请求在发出之前失败，因此被拒绝的 attempt 不会有任何请求到达 provider；
 * - token 上限按单次调用的预留值检查：额度不足时在发出之前失败。已经发出的多个并发
 *   调用各自按实际 usage 计账，累计超出量可能多于一个调用的超出量；账本阻塞之后，
 *   请求在下一次模型调用之前停止；
 * - provider 上报 usage 时按真实 token 计账，不上报时该次调用记为 unknown，账本随即
 *   阻塞，下一次模型调用在发出之前失败，请求以明确原因结束；
 * - 进程中断后重新打开账本时，pending 调用会变成 unknown，账本保持阻塞，
 *   不会被当作成功；
 * - provider 原生压缩器上报 usage 时按真实用量计账；不上报时按预留值保守计账，
 *   账本把它标记为估计值，统计中不会把它当成完整用量。
 */
export class SubagentRequestLedger {
  private readonly reservationTokens: number;
  private active = 0;
  private closed = false;

  private constructor(
    private readonly budget: FileSharedBudget,
    reservationTokens: number,
  ) {
    this.reservationTokens = reservationTokens;
  }

  /** 打开请求账本；同一 id 的历史账本会被读取，并保持它记录的阻塞状态。 */
  static async open(
    directory: string,
    id: string,
    limits: SubagentBudgetLimits,
  ): Promise<SubagentRequestLedger> {
    const { reservationTokens, ...shared } = limits;
    const budget = await FileSharedBudget.open(join(directory, "budget"), id, shared);
    return new SubagentRequestLedger(budget, reservationTokens);
  }

  /**
   * 一次模型调用：先预留额度，再流式转发，最后按真实 usage 计账。
   *
   * `retrying` 事件到达时，上一次尝试已经失败且没有 usage，因此记为 unknown；
   * 随后的预留失败会在转发该事件之前抛出，重试包装随之结束，不会发出下一 attempt。
   * 这次抛错保留事件里的 provider 错误：它的 name、message、code 与失败 attempt 的
   * 调用身份都在错误中，宿主因此既能看到触发重试的原始错误，也能看到账本阻塞的原因。
   *
   * 预留等待期间计入在途调用，预留失败时同样完整释放，请求目录的写入者可以正常关闭。
   */
  async *account(
    options: ModelStreamOptions,
    events: AsyncIterable<ModelEvent>,
  ): AsyncIterable<ModelEvent> {
    if (this.closed) throw new Error("The request budget is closed");
    const reservation = { totalTokens: this.reservationTokens };
    const callId = attemptCallId(options, 1);
    this.active += 1;
    try {
      await this.budget.reserveCall(callId, reservation);
      // 当前 attempt 已经有确定结论：已结账或已记为 unknown。
      let concluded = false;
      let current = callId;
      try {
        for await (const event of events) {
          if (event.type === "retrying") {
            if (concluded) throw new Error("Model requested a retry after a completed response");
            await this.budget.markCallUnknown(current);
            concluded = true;
            // 预留失败时不改写 current，未创建的 attempt 不会被记入账本。
            const next = attemptCallId(options, event.attempt);
            try {
              await this.budget.reserveCall(next, reservation);
            } catch (error) {
              throw budgetRefusedRetry(error, current, event.error);
            }
            current = next;
            concluded = false;
          }
          if (event.type === "response.completed") {
            if (concluded) throw new Error("Model emitted multiple completion events");
            await this.budget.settleCall(current, event.usage);
            concluded = true;
          }
          yield event;
        }
        if (!concluded) await this.budget.markCallUnknown(current);
      } catch (error) {
        if (error instanceof ModelResponseValidationError) {
          let cost = error.cost;
          let failure = error;
          if (!concluded && error.usage !== undefined) {
            try {
              const priced = this.budget.limits.pricing !== undefined || this.budget.limits.tokenPrices !== undefined || error.usage.reportedCost !== undefined;
              const preparedCost = priced ? cost ?? priceUsage(error.usage, this.budget.limits.pricing ?? this.budget.limits.tokenPrices) : undefined;
              cost = preparedCost ?? cost;
              await this.budget.settleCall(current, error.usage, preparedCost);
              concluded = true;
              if (priced) cost = (await this.budget.snapshot()).calls.find(call => call.id === current)?.cost;
              failure = new ModelResponseValidationError(error.message, { cause: error, usage: error.usage, ...(cost === undefined ? {} : { cost }) });
            } catch (accountingError) { failure = validationAccountingError(error, accountingError, cost); }
          }
          if (!concluded) {
            try { await this.budget.markCallUnknown(current); }
            catch (accountingError) { throw validationAccountingError(failure, accountingError, cost); }
          }
          throw failure;
        }
        if (!concluded) await this.budget.markCallUnknown(current);
        throw error;
      }
    } finally {
      this.active -= 1;
    }
  }

  /**
   * 不由 Model 接口发起的调用，例如 provider 原生上下文压缩。
   *
   * 预留等待期间同样计入在途调用，因此账本不会在压缩请求还没有结束时关闭。
   */
  external<T extends ExternalCallResult>(id: string, operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("The request budget is closed");
    this.active += 1;
    return this.budget
      .runExternal(id, { totalTokens: this.reservationTokens }, operation)
      .finally(() => { this.active -= 1; });
  }

  async totals(): Promise<SharedBudgetTotals> {
    return await this.budget.totals();
  }

  /** 账本快照：每次调用的状态，用于报告 usage 完整性。 */
  async snapshot(): Promise<SharedBudgetSnapshot> {
    return await this.budget.snapshot();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.active > 0) {
      throw new Error("Cannot close the request budget while model or external calls are active");
    }
    this.closed = true;
    await this.budget.close();
  }
}

function validationAccountingError(error: ModelResponseValidationError, accountingError: unknown, cost?: UsageCost): ModelResponseValidationError {
  return new ModelResponseValidationError(error.message, { cause: new AggregateError([error, accountingError], "Model response validation and request budget accounting failed"),
    ...(error.usage === undefined ? {} : { usage: error.usage }), ...(cost === undefined ? {} : { cost }) });
}

/**
 * 每次 attempt 的唯一身份。
 *
 * May 的模型调用使用 `modelCallId`；Run 内的摘要调用只有 runId 与 step；
 * 重试的 attempt 在其后附加 provider 给出的 attempt 序号，因此每一次真实尝试
 * 在一本账本内都有各自的条目，同一个 modelCallId 不会被预留两次。
 */
function attemptCallId(options: ModelStreamOptions, attempt: number): string {
  if (options.modelCallId !== undefined) {
    return attempt === 1 ? options.modelCallId : `${options.modelCallId}:retry:${attempt}`;
  }
  if (options.runId !== undefined) {
    const summary = `${options.runId}:summary:${options.step ?? 0}`;
    return attempt === 1 ? summary : `${summary}:retry:${attempt}`;
  }
  throw new Error("The request budget requires a stable modelCallId or runId for every model call");
}

/**
 * 账本拒绝下一次 attempt 时抛出的错误。
 *
 * 事件里的 provider 错误就是触发这次重试的原因，也是宿主需要看到的失败原因，因此它的
 * name、message、code 与失败 attempt 的调用身份都保留下来：宿主只把 name、message、
 * code 写进持久化的 `run.failed`，message 里另外写明账本阻塞的原因。
 */
function budgetRefusedRetry(
  refusal: unknown,
  callId: string,
  provider: SerializedError,
): Error {
  const reason = refusal instanceof Error ? refusal.message : String(refusal);
  const error = new Error(
    `Request budget refused the retry of model call ${callId} after ${provider.name}: ` +
    `${provider.message}${provider.code === undefined ? "" : ` (code ${provider.code})`}; ${reason}`,
    { cause: refusal },
  );
  error.name = provider.name;
  if (provider.code !== undefined) Object.assign(error, { code: provider.code });
  return error;
}

/** 原生压缩的调用身份：Run 内使用 runId 与 step，Run 之外的调用使用随机身份。 */
function compactionCallId(options: { readonly runId?: string; readonly step?: number }): string {
  return options.runId === undefined
    ? `compaction:${randomUUID()}`
    : `${options.runId}:compaction:${options.step ?? 0}`;
}

/**
 * 包裹模型：活动请求存在时按账本计账，没有活动请求时直接透传。
 *
 * 主会话模型与子 Agent 模型都使用这个包装，因此两者的调用计入同一本账。
 */
export function withRequestBudget(
  model: Model,
  ledger: () => SubagentRequestLedger | undefined,
): Model {
  const compactor = model.contextCompactor;
  return {
    get limits() { return model.limits; },
    get reportsAttempts() { return model.reportsAttempts; },
    get capabilityVersion() { return model.capabilityVersion; },
    get configuration() { return model.configuration; },
    ...(model.preflight === undefined ? {} : { preflight: model.preflight.bind(model) }),
    ...(compactor === undefined ? {} : { contextCompactor: {
      name: compactor.name,
      async compact(snapshot, options) {
        const active = ledger();
        if (active === undefined) return await compactor.compact(snapshot, options);
        // provider 上报的 usage 随结果一起计账；没有 usage 时按预留值计账并标记为估计值。
        return await active.external(
          compactionCallId(options),
          () => compactor.compact(snapshot, options),
        );
      },
    } }),
    async *stream(request, options) {
      const active = ledger();
      if (active === undefined) {
        yield* model.stream(request, options);
        return;
      }
      yield* active.account(options, model.stream(request, options));
    },
  };
}
