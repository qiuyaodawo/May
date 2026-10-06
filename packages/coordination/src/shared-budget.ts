import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Model, ModelEvent, Usage } from "@may/core";
import { ModelResponseValidationError, priceUsage, resolvePriceSchedule, resolveUsageTotals, validateUsageCost, type TokenPrices, type TokenPriceSchedule, type UsageCost, type UsagePricer } from "@may/core";
import { ResourceJournal, amount, count, resourceId } from "./resource-journal.js";

export interface SharedBudgetLimits {
  readonly maxModelCalls: number;
  readonly maxTotalTokens?: number;
  readonly maxCostUsd?: number;
  readonly tokenPrices?: TokenPrices;
  readonly pricing?: TokenPriceSchedule;
}

export interface SharedBudgetOptions { readonly usagePricer?: UsagePricer }

/** Host-selected upper estimate. Provider output limits must be configured separately. */
export interface ModelReservation { readonly totalTokens: number; readonly costUsd?: number }

export interface SharedBudgetCall {
  readonly id: string;
  readonly status: "pending" | "settled" | "unknown";
  readonly reservation: ModelReservation;
  readonly usage?: Usage;
  readonly totalTokens?: number;
  readonly costUsd?: number;
  readonly cost?: UsageCost;
  /** provider 上报 usage 时为 true；估计值只是宿主给出的保守计账。 */
  readonly estimated?: boolean;
  readonly exceededReservation?: boolean;
  readonly reconciliation?: string;
}

export interface SharedBudgetSnapshot {
  readonly format: 1;
  readonly revision: number;
  readonly id: string;
  readonly limits: SharedBudgetLimits;
  readonly calls: readonly SharedBudgetCall[];
}

export interface SharedBudgetTotals {
  readonly modelCalls: number;
  /** Includes pending/unknown reservations; not merely completed calls. */
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly blocked: boolean;
  /**
   * 每次调用都按 provider 上报的 usage 结账时为 true。
   *
   * 按预留值计账的估计值与没有 usage 的调用都会使它变成 false，
   * 因此用量统计不会把估计值当成完整统计。
   */
  readonly usageComplete: boolean;
  readonly costComplete?: boolean;
}

/** 不经过 Model 接口发起的调用的结果。 */
export interface ExternalCallResult {
  /** provider 上报的 usage；缺失时按预留值计账并标记为估计值。 */
  readonly usage?: Usage;
}

/** Team-wide, single-host model-call accounting, independent of individual Run budgets. */
export class FileSharedBudget {
  private readonly active = new Set<string>();
  private failed = false;
  private constructor(private readonly journal: ResourceJournal<SharedBudgetSnapshot>, readonly limits: SharedBudgetLimits, private readonly usagePricer?: UsagePricer) {}

  /** Monitoring only: pending calls remain pending, no lock stealing or reconciliation. */
  static inspect(directory: string, id: string, limits: SharedBudgetLimits, options: SharedBudgetOptions = {}): Promise<SharedBudgetSnapshot | undefined> {
    resourceId(id, "shared budget id"); validateLimits(limits, options);
    return ResourceJournal.inspect(join(resolve(directory), `${createHash("sha256").update(id).digest("hex")}.budget.jsonl`),
      (state: SharedBudgetSnapshot) => validate(state, id, limits, options.usagePricer));
  }

  static async open(directory: string, id: string, limits: SharedBudgetLimits, options: SharedBudgetOptions = {}): Promise<FileSharedBudget> {
    resourceId(id, "shared budget id"); validateLimits(limits, options);
    const frozen = Object.freeze({ ...limits, ...(limits.tokenPrices ? { tokenPrices: Object.freeze({ ...limits.tokenPrices }) } : {}),
      ...(limits.pricing === undefined ? {} : { pricing: resolvePriceSchedule(limits.pricing) as TokenPriceSchedule }) });
    const initial: SharedBudgetSnapshot = { format: 1, revision: 0, id, limits: frozen, calls: [] };
    const journal = await ResourceJournal.open(join(resolve(directory), `${createHash("sha256").update(id).digest("hex")}.budget.jsonl`), initial,
      (state) => validate(state, id, frozen, options.usagePricer));
    try {
      const snapshot = await journal.snapshot();
      // A reservation surviving process ownership has unknown provider effects, even if no result was saved.
      if (snapshot.calls.some((call) => call.status === "pending")) {
        await journal.transact((state) => ({ ...state, calls: state.calls.map((call) => call.status === "pending" ? { ...call, status: "unknown" as const } : call) }));
      }
      return new FileSharedBudget(journal, frozen, options.usagePricer);
    } catch (error) { await journal.close(); throw error; }
  }

  snapshot(): Promise<SharedBudgetSnapshot> { return this.journal.snapshot(); }

  async totals(): Promise<SharedBudgetTotals> { return sharedBudgetTotals(await this.snapshot()); }

  /** Place at the physical request boundary, inside retry wrappers; hidden retries are not accounted. */
  wrapModel(model: Model, options: { readonly reservation: ModelReservation }): Model {
    const reservation = Object.freeze({ ...options.reservation });
    validateReservation(reservation, this.limits);
    const budget = this;
    return {
      get limits() { return model.limits; },
      get reportsAttempts() { return model.reportsAttempts; },
      get capabilityVersion() { return model.capabilityVersion; },
      get configuration() { return model.configuration; },
      ...(model.preflight === undefined ? {} : { preflight: model.preflight.bind(model) }),
      // Native compaction would be a hidden provider call without usage; deliberately not forwarded.
      async *stream(request, streamOptions): AsyncIterable<ModelEvent> {
        streamOptions.signal.throwIfAborted();
        const id = streamOptions.modelCallId;
        if (id === undefined) throw new Error("Shared budget requires a stable modelCallId");
        if (budget.active.has(id)) throw new Error("Model call already active");
        budget.active.add(id);
        let settled = false;
        let reserved = false;
        let validationError: ModelResponseValidationError | undefined;
        try {
          await budget.reserve(id, reservation); reserved = true;
          streamOptions.signal.throwIfAborted();
          for await (const event of model.stream(request, streamOptions)) {
            if (event.type === "response.completed") {
              if (settled) { settled = false; throw new Error("Model emitted multiple completion events"); }
              const snapshot = await budget.settle(id, event.usage);
              settled = true;
              if (sharedBudgetTotals(snapshot).blocked) throw new Error("Shared budget exceeded; model result was not released to tools");
              const cost = snapshot.calls.find(call => call.id === id)?.cost;
              if (cost !== undefined && (budget.limits.pricing !== undefined || budget.limits.tokenPrices !== undefined || budget.usagePricer !== undefined || event.usage?.reportedCost !== undefined)) { yield { ...event, cost }; continue; }
            }
            yield event;
          }
          if (!settled) throw new Error("Model stream ended without accounted usage");
        } catch (error) {
          if (error instanceof ModelResponseValidationError) {
            validationError = error;
            if (reserved && !settled && error.usage !== undefined) {
              let cost = error.cost;
              const priced = budget.limits.pricing !== undefined || budget.limits.tokenPrices !== undefined || budget.usagePricer !== undefined || error.usage.reportedCost !== undefined;
              try {
                const preparedCost = priced ? cost ?? priceUsage(error.usage, budget.limits.pricing ?? budget.limits.tokenPrices, budget.usagePricer) : undefined;
                cost = preparedCost ?? cost;
                const snapshot = await budget.settle(id, error.usage, false, preparedCost);
                settled = true;
                if (priced) cost = snapshot.calls.find(call => call.id === id)?.cost;
                validationError = new ModelResponseValidationError(error.message, { cause: error, usage: error.usage, ...(cost === undefined ? {} : { cost }) });
                if (sharedBudgetTotals(snapshot).blocked) throw new Error("Shared budget exceeded after an invalid model response");
              } catch (accountingError) {
                validationError = validationAccountingError(error, accountingError, cost);
              }
              throw validationError;
            }
          }
          throw error;
        } finally {
          try {
            if (reserved && !settled) {
              try { await budget.markUnknown(id); }
              catch (error) { budget.failed = true; throw validationError === undefined ? error : validationAccountingError(validationError, error, validationError.cost); }
            }
          } finally { budget.active.delete(id); }
        }
      },
    };
  }

  /**
   * 在发起调用前原子预留额度。额度不足或账本已阻塞时立即抛错，不发出任何请求。
   */
  async reserveCall(id: string, reservation: ModelReservation): Promise<void> {
    await this.reserve(id, reservation);
  }

  /**
   * 调用完成后按真实 usage 计账。usage 不可用时该调用记为 unknown，账本随即阻塞，
   * 下一个调用会在发出前失败。
   */
  async settleCall(id: string, usage: Usage | undefined, preparedCost?: UsageCost): Promise<void> {
    if (usage === undefined) { await this.markUnknown(id); return; }
    await this.settle(id, usage, false, preparedCost);
  }

  /** 调用失败或被中断：该调用记为 unknown，需要宿主核对外部影响。 */
  async markCallUnknown(id: string): Promise<void> {
    await this.markUnknown(id);
  }

  /**
   * 为不由 Model 接口发起的调用预留额度并计账，例如 provider 原生上下文压缩。
   *
   * 结果带 provider 上报的 usage 时按真实用量结账；没有 usage 时按预留值保守计账，
   * 并在账本中标记为估计值。调用失败时该调用记为 unknown。
   *
   * 预留等待与调用过程都计入在途调用，因此账本不会在它结束之前关闭。
   */
  async runExternal<T extends ExternalCallResult>(
    id: string,
    reservation: ModelReservation,
    operation: () => Promise<T>,
  ): Promise<T> {
    resourceId(id, "model call id");
    if (this.active.has(id)) throw new Error("Model call already active");
    this.active.add(id);
    try {
      await this.reserve(id, reservation);
      let settled = false;
      try {
        const result = await operation();
        const reported = result.usage;
        await this.settle(id, reported ?? { totalTokens: reservation.totalTokens }, reported === undefined);
        settled = true;
        return result;
      } finally {
        if (!settled) await this.markCallUnknown(id);
      }
    } finally {
      this.active.delete(id);
    }
  }

  /** Host-only verified accounting. Never retries a provider request or releases a tool result. */
  async reconcile(callId: string, usage: Usage, evidence: string): Promise<void> {
    resourceId(callId, "model call id"); resourceId(evidence, "reconciliation evidence");
    if (this.active.has(callId)) throw new Error("Cannot reconcile an active model call");
    const actual = usageTotals(usage, this.limits, this.usagePricer);
    await this.journal.transact((state) => {
      const call = state.calls.find((candidate) => candidate.id === callId);
      if (!call || (call.status !== "unknown" && !call.exceededReservation)) throw new Error("Only unknown usage or an exceeded reservation can be reconciled");
      return { ...state, calls: state.calls.map((candidate) => candidate.id === callId
        ? { ...candidate, status: "settled" as const, usage: { ...usage }, ...actual,
          estimated: false, exceededReservation: false, reconciliation: evidence } : candidate) };
    });
  }

  close(): Promise<void> {
    if (this.active.size > 0) return Promise.reject(new Error("Cannot close a shared budget while model or external calls are active"));
    return this.journal.close();
  }

  private async reserve(id: string, reservation: ModelReservation): Promise<void> {
    if (this.failed) throw new Error("Shared budget write outcome unknown; reopen before continuing");
    resourceId(id, "model call id");
    await this.journal.transact((state) => {
      if (state.calls.some((call) => call.id === id)) throw new Error("Model call already reserved; inspect/reconcile instead of replaying it");
      const totals = sharedBudgetTotals(state);
      if (totals.blocked) throw new Error(budgetBlockedMessage(state, totals));
      if (totals.modelCalls + 1 > state.limits.maxModelCalls ||
        (state.limits.maxTotalTokens !== undefined && totals.totalTokens + reservation.totalTokens > state.limits.maxTotalTokens) ||
        (state.limits.maxCostUsd !== undefined && totals.costUsd + reservation.costUsd! > state.limits.maxCostUsd)) throw new Error("Shared budget has insufficient unreserved capacity");
      return { ...state, calls: [...state.calls, { id, status: "pending", reservation }] };
    });
  }

  private settle(id: string, usage?: Usage, estimated = false, preparedCost?: UsageCost): Promise<SharedBudgetSnapshot> {
    return this.journal.transact((state) => ({ ...state, calls: state.calls.map((call) => {
      if (call.id !== id) return call;
      const actual = estimated ? estimatedTotals(call.reservation) : usageTotals(usage, this.limits, this.usagePricer, preparedCost);
      return { ...call, status: "settled" as const, usage: { ...usage }, ...actual,
        ...(estimated ? { estimated: true } : {}),
        exceededReservation: actual.totalTokens > call.reservation.totalTokens ||
          (call.reservation.costUsd !== undefined && actual.costUsd > call.reservation.costUsd) };
    }) }));
  }

  private async markUnknown(id: string): Promise<void> {
    await this.journal.transact((state) => ({ ...state, calls: state.calls.map((call) => call.id === id ? { ...call, status: "unknown" as const } : call) }));
  }
}

export function sharedBudgetTotals(snapshot: SharedBudgetSnapshot): SharedBudgetTotals {
  // 预留超出只在账本设有 token 或成本上限时才阻塞：没有上限时真实用量就是事实。
  const bounded = snapshot.limits.maxTotalTokens !== undefined || snapshot.limits.maxCostUsd !== undefined;
  const totals = snapshot.calls.reduce((sum, call) => ({ modelCalls: sum.modelCalls + 1,
    totalTokens: sum.totalTokens + (call.status === "settled" ? call.totalTokens! : call.reservation.totalTokens),
    costUsd: sum.costUsd + (call.status === "settled" ? call.costUsd! : call.reservation.costUsd ?? 0),
    blocked: sum.blocked || call.status === "unknown" || (bounded && call.exceededReservation === true) }),
  { modelCalls: 0, totalTokens: 0, costUsd: 0, blocked: false });
  return { ...totals,
    usageComplete: snapshot.calls.every((call) => call.status === "settled" && call.estimated !== true && resolveUsageTotals(call.usage).complete),
    costComplete: snapshot.calls.every((call) => call.status === "settled" && call.estimated !== true && call.cost?.complete === true && call.cost.currency === "USD"),
    blocked: totals.blocked || totals.modelCalls > snapshot.limits.maxModelCalls ||
    (snapshot.limits.maxTotalTokens !== undefined && totals.totalTokens > snapshot.limits.maxTotalTokens) ||
    (snapshot.limits.maxCostUsd !== undefined && totals.costUsd > snapshot.limits.maxCostUsd) };
}

function budgetBlockedMessage(state: SharedBudgetSnapshot, totals: SharedBudgetTotals): string {
  if (state.calls.some((call) => call.status === "unknown")) {
    return "Shared budget has unknown model usage; reconcile it before continuing";
  }
  if (totals.modelCalls > state.limits.maxModelCalls) {
    return `Shared budget model call limit reached (${totals.modelCalls}/${state.limits.maxModelCalls})`;
  }
  if (state.limits.maxTotalTokens !== undefined && totals.totalTokens > state.limits.maxTotalTokens) {
    return `Shared budget token limit reached (${totals.totalTokens}/${state.limits.maxTotalTokens} tokens)`;
  }
  return `Shared budget cost limit reached (${totals.costUsd}/${state.limits.maxCostUsd} USD)`;
}

function validateLimits(limits: SharedBudgetLimits, options: SharedBudgetOptions): void {
  count(limits.maxModelCalls, "maxModelCalls");
  if (limits.maxModelCalls > 10_000) throw new RangeError("maxModelCalls exceeds the local ledger bound of 10000");
  if (limits.maxTotalTokens !== undefined) count(limits.maxTotalTokens, "maxTotalTokens");
  if (limits.tokenPrices !== undefined && limits.pricing !== undefined) throw new TypeError("Configure pricing or tokenPrices independently");
  const pricing = resolvePriceSchedule(limits.pricing ?? limits.tokenPrices);
  if (options.usagePricer !== undefined && typeof options.usagePricer !== "function") throw new TypeError("usagePricer must be a function");
  if (limits.maxCostUsd !== undefined) {
    amount(limits.maxCostUsd, "maxCostUsd");
    if (pricing === undefined && options.usagePricer === undefined) throw new Error("A shared cost budget requires explicit pricing, tokenPrices, or usagePricer");
    if (pricing !== undefined && pricing.currency !== "USD") throw new Error("A shared cost budget requires USD pricing");
  }
}

function validateReservation(reservation: ModelReservation, limits: SharedBudgetLimits): void {
  count(reservation.totalTokens, "reservation.totalTokens");
  if (reservation.costUsd !== undefined) amount(reservation.costUsd, "reservation.costUsd");
  if (limits.maxCostUsd !== undefined && reservation.costUsd === undefined) throw new Error("A shared cost budget requires a per-call cost reservation");
}

function usageTotals(usage: Usage | undefined, limits: SharedBudgetLimits, pricer?: UsagePricer, preparedCost?: UsageCost): { totalTokens: number; costUsd: number; cost: UsageCost } {
  const totals = resolveUsageTotals(usage);
  const totalTokens = totals.totalTokens;
  if (totalTokens === undefined || !totals.complete) throw new Error("Shared budget usage is unavailable; host reconciliation is required");
  const cost = preparedCost === undefined ? priceUsage(usage, limits.pricing ?? limits.tokenPrices, pricer) : validateUsageCost(preparedCost);
  const priced = cost.complete && cost.currency === "USD" && cost.amount !== undefined;
  if (limits.maxCostUsd !== undefined && !priced) throw new Error("Shared cost budget usage is unavailable; complete USD accounting is required");
  const costUsd = priced ? cost.amount! : 0;
  amount(costUsd, "model cost");
  return { totalTokens, costUsd, cost };
}

function validationAccountingError(error: ModelResponseValidationError, accountingError: unknown, cost?: UsageCost): ModelResponseValidationError {
  return new ModelResponseValidationError(error.message, { cause: new AggregateError([error, accountingError], "Model response validation and budget accounting failed"),
    ...(error.usage === undefined ? {} : { usage: error.usage }), ...(cost === undefined ? {} : { cost }) });
}

function estimatedTotals(reservation: ModelReservation): { totalTokens: number; costUsd: number; cost: UsageCost } {
  return { totalTokens: reservation.totalTokens, costUsd: reservation.costUsd ?? 0,
    cost: { ...(reservation.costUsd === undefined ? {} : { amount: reservation.costUsd }), currency: "USD", kind: "estimated", complete: false, source: "reservation", missingReasons: ["provider-usage-missing"] } };
}

function validate(state: SharedBudgetSnapshot, id: string, limits: SharedBudgetLimits, pricer?: UsagePricer): void {
  if (!state || state.format !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || state.id !== id ||
    !isDeepStrictEqual(state.limits, limits) || !Array.isArray(state.calls) || state.calls.length > limits.maxModelCalls) throw new Error("Invalid shared budget journal or changed limits");
  const ids = new Set<string>();
  for (const call of state.calls) {
    resourceId(call.id, "model call id"); validateReservation(call.reservation, limits);
    if (ids.has(call.id) || !["pending", "settled", "unknown"].includes(call.status)) throw new Error("Invalid shared budget call");
    if (call.estimated !== undefined && (typeof call.estimated !== "boolean" || call.status !== "settled")) {
      throw new Error("Invalid shared budget estimate");
    }
    ids.add(call.id);
    if (call.status === "settled") {
      const actual = call.estimated === true ? estimatedTotals(call.reservation) : pricer === undefined ? usageTotals(call.usage, limits) : storedUsageTotals(call, limits);
      if (call.totalTokens !== actual.totalTokens || call.costUsd !== actual.costUsd) throw new Error("Inconsistent shared budget usage");
      if (call.cost !== undefined && !isDeepStrictEqual(call.cost, actual.cost)) throw new Error("Inconsistent shared budget pricing result");
    }
  }
}

function storedUsageTotals(call: SharedBudgetCall, limits: SharedBudgetLimits): { totalTokens: number; costUsd: number; cost: UsageCost } {
  const totals = resolveUsageTotals(call.usage);
  if (!totals.complete || totals.totalTokens === undefined || call.cost === undefined) throw new Error("Shared budget custom pricing receipt is unavailable");
  const cost = validateUsageCost(call.cost);
  const priced = cost.complete && cost.currency === "USD" && cost.amount !== undefined;
  if (limits.maxCostUsd !== undefined && !priced) throw new Error("Shared cost budget requires complete USD accounting");
  return { totalTokens: totals.totalTokens, costUsd: priced ? cost.amount! : 0, cost };
}
