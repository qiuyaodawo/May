import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Model, ModelEvent, Usage } from "@may/core";
import { ResourceJournal, amount, count, resourceId } from "./resource-journal.js";

export interface SharedBudgetLimits {
  readonly maxModelCalls: number;
  readonly maxTotalTokens?: number;
  readonly maxCostUsd?: number;
  readonly tokenPrices?: { readonly inputUsdPerMillion: number; readonly outputUsdPerMillion: number };
}

/** Host-selected upper estimate. Provider output limits must be configured separately. */
export interface ModelReservation { readonly totalTokens: number; readonly costUsd?: number }

export interface SharedBudgetCall {
  readonly id: string;
  readonly status: "pending" | "settled" | "unknown";
  readonly reservation: ModelReservation;
  readonly usage?: Usage;
  readonly totalTokens?: number;
  readonly costUsd?: number;
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
}

/** Team-wide, single-host model-call accounting, independent of individual Run budgets. */
export class FileSharedBudget {
  private readonly active = new Set<string>();
  private failed = false;
  private constructor(private readonly journal: ResourceJournal<SharedBudgetSnapshot>, readonly limits: SharedBudgetLimits) {}

  /** Monitoring only: pending calls remain pending, no lock stealing or reconciliation. */
  static inspect(directory: string, id: string, limits: SharedBudgetLimits): Promise<SharedBudgetSnapshot | undefined> {
    resourceId(id, "shared budget id"); validateLimits(limits);
    return ResourceJournal.inspect(join(resolve(directory), `${createHash("sha256").update(id).digest("hex")}.budget.jsonl`),
      (state: SharedBudgetSnapshot) => validate(state, id, limits));
  }

  static async open(directory: string, id: string, limits: SharedBudgetLimits): Promise<FileSharedBudget> {
    resourceId(id, "shared budget id"); validateLimits(limits);
    const frozen = Object.freeze({ ...limits, ...(limits.tokenPrices ? { tokenPrices: Object.freeze({ ...limits.tokenPrices }) } : {}) });
    const initial: SharedBudgetSnapshot = { format: 1, revision: 0, id, limits: frozen, calls: [] };
    const journal = await ResourceJournal.open(join(resolve(directory), `${createHash("sha256").update(id).digest("hex")}.budget.jsonl`), initial,
      (state) => validate(state, id, frozen));
    try {
      const snapshot = await journal.snapshot();
      // A reservation surviving process ownership has unknown provider effects, even if no result was saved.
      if (snapshot.calls.some((call) => call.status === "pending")) {
        await journal.transact((state) => ({ ...state, calls: state.calls.map((call) => call.status === "pending" ? { ...call, status: "unknown" as const } : call) }));
      }
      return new FileSharedBudget(journal, frozen);
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
      ...(model.limits === undefined ? {} : { limits: model.limits }),
      // Native compaction would be a hidden provider call without usage; deliberately not forwarded.
      async *stream(request, streamOptions): AsyncIterable<ModelEvent> {
        streamOptions.signal.throwIfAborted();
        const id = streamOptions.modelCallId;
        if (id === undefined) throw new Error("Shared budget requires a stable modelCallId");
        if (budget.active.has(id)) throw new Error("Model call already active");
        budget.active.add(id);
        let settled = false;
        let reserved = false;
        try {
          await budget.reserve(id, reservation); reserved = true;
          streamOptions.signal.throwIfAborted();
          for await (const event of model.stream(request, streamOptions)) {
            if (event.type === "response.completed") {
              if (settled) { settled = false; throw new Error("Model emitted multiple completion events"); }
              const snapshot = await budget.settle(id, event.usage);
              settled = true;
              if (sharedBudgetTotals(snapshot).blocked) throw new Error("Shared budget exceeded; model result was not released to tools");
            }
            yield event;
          }
          if (!settled) throw new Error("Model stream ended without accounted usage");
        } finally {
          try {
            if (reserved && !settled) {
              try { await budget.markUnknown(id); }
              catch (error) { budget.failed = true; throw error; }
            }
          } finally { budget.active.delete(id); }
        }
      },
    };
  }

  /** Host-only verified accounting. Never retries a provider request or releases a tool result. */
  async reconcile(callId: string, usage: Usage, evidence: string): Promise<void> {
    resourceId(callId, "model call id"); resourceId(evidence, "reconciliation evidence");
    if (this.active.has(callId)) throw new Error("Cannot reconcile an active model call");
    const actual = usageTotals(usage, this.limits);
    await this.journal.transact((state) => {
      const call = state.calls.find((candidate) => candidate.id === callId);
      if (!call || (call.status !== "unknown" && !call.exceededReservation)) throw new Error("Only unknown usage or an exceeded reservation can be reconciled");
      return { ...state, calls: state.calls.map((candidate) => candidate.id === callId
        ? { ...candidate, status: "settled" as const, usage: { ...usage }, ...actual,
          exceededReservation: false, reconciliation: evidence } : candidate) };
    });
  }

  close(): Promise<void> {
    if (this.active.size > 0) return Promise.reject(new Error("Cannot close a shared budget while model calls are active"));
    return this.journal.close();
  }

  private async reserve(id: string, reservation: ModelReservation): Promise<void> {
    if (this.failed) throw new Error("Shared budget write outcome unknown; reopen before continuing");
    resourceId(id, "model call id");
    await this.journal.transact((state) => {
      if (state.calls.some((call) => call.id === id)) throw new Error("Model call already reserved; inspect/reconcile instead of replaying it");
      const totals = sharedBudgetTotals(state);
      if (totals.blocked) throw new Error("Shared budget blocked by unknown usage or an exceeded reservation");
      if (totals.modelCalls + 1 > state.limits.maxModelCalls ||
        (state.limits.maxTotalTokens !== undefined && totals.totalTokens + reservation.totalTokens > state.limits.maxTotalTokens) ||
        (state.limits.maxCostUsd !== undefined && totals.costUsd + reservation.costUsd! > state.limits.maxCostUsd)) throw new Error("Shared budget has insufficient unreserved capacity");
      return { ...state, calls: [...state.calls, { id, status: "pending", reservation }] };
    });
  }

  private settle(id: string, usage?: Usage): Promise<SharedBudgetSnapshot> {
    const actual = usageTotals(usage, this.limits);
    return this.journal.transact((state) => ({ ...state, calls: state.calls.map((call) => call.id === id
      ? { ...call, status: "settled" as const, usage: { ...usage }, ...actual,
        exceededReservation: actual.totalTokens > call.reservation.totalTokens ||
          (call.reservation.costUsd !== undefined && actual.costUsd > call.reservation.costUsd) } : call) }));
  }

  private async markUnknown(id: string): Promise<void> {
    await this.journal.transact((state) => ({ ...state, calls: state.calls.map((call) => call.id === id ? { ...call, status: "unknown" as const } : call) }));
  }
}

export function sharedBudgetTotals(snapshot: SharedBudgetSnapshot): SharedBudgetTotals {
  const totals = snapshot.calls.reduce((sum, call) => ({ modelCalls: sum.modelCalls + 1,
    totalTokens: sum.totalTokens + (call.status === "settled" ? call.totalTokens! : call.reservation.totalTokens),
    costUsd: sum.costUsd + (call.status === "settled" ? call.costUsd! : call.reservation.costUsd ?? 0),
    blocked: sum.blocked || call.status === "unknown" || call.exceededReservation === true }),
  { modelCalls: 0, totalTokens: 0, costUsd: 0, blocked: false });
  return { ...totals, blocked: totals.blocked || totals.modelCalls > snapshot.limits.maxModelCalls ||
    (snapshot.limits.maxTotalTokens !== undefined && totals.totalTokens > snapshot.limits.maxTotalTokens) ||
    (snapshot.limits.maxCostUsd !== undefined && totals.costUsd > snapshot.limits.maxCostUsd) };
}

function validateLimits(limits: SharedBudgetLimits): void {
  count(limits.maxModelCalls, "maxModelCalls");
  if (limits.maxModelCalls > 10_000) throw new RangeError("maxModelCalls exceeds the local ledger bound of 10000");
  if (limits.maxTotalTokens !== undefined) count(limits.maxTotalTokens, "maxTotalTokens");
  if (limits.maxCostUsd !== undefined) { amount(limits.maxCostUsd, "maxCostUsd"); if (!limits.tokenPrices) throw new Error("A shared cost budget requires explicit tokenPrices"); }
  if (limits.tokenPrices) { amount(limits.tokenPrices.inputUsdPerMillion, "input token price"); amount(limits.tokenPrices.outputUsdPerMillion, "output token price"); }
}

function validateReservation(reservation: ModelReservation, limits: SharedBudgetLimits): void {
  count(reservation.totalTokens, "reservation.totalTokens");
  if (reservation.costUsd !== undefined) amount(reservation.costUsd, "reservation.costUsd");
  if (limits.maxCostUsd !== undefined && reservation.costUsd === undefined) throw new Error("A shared cost budget requires a per-call cost reservation");
}

function usageTotals(usage: Usage | undefined, limits: SharedBudgetLimits): { totalTokens: number; costUsd: number } {
  const valid = (value: number | undefined): value is number => value !== undefined && Number.isSafeInteger(value) && value >= 0;
  const components = valid(usage?.inputTokens) && valid(usage?.outputTokens) ? usage.inputTokens + usage.outputTokens : undefined;
  const totalTokens = valid(usage?.totalTokens) ? Math.max(usage.totalTokens, components ?? 0) : components;
  if (totalTokens === undefined || !Number.isSafeInteger(totalTokens)) throw new Error("Shared budget usage is unavailable; host reconciliation is required");
  const prices = limits.tokenPrices;
  if (limits.maxCostUsd !== undefined && (!valid(usage?.inputTokens) || !valid(usage?.outputTokens))) throw new Error("Shared cost budget requires input and output token usage");
  const costUsd = prices && valid(usage?.inputTokens) && valid(usage?.outputTokens)
    ? (usage.inputTokens * prices.inputUsdPerMillion + usage.outputTokens * prices.outputUsdPerMillion) / 1_000_000 : 0;
  amount(costUsd, "model cost");
  return { totalTokens, costUsd };
}

function validate(state: SharedBudgetSnapshot, id: string, limits: SharedBudgetLimits): void {
  if (!state || state.format !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || state.id !== id ||
    !isDeepStrictEqual(state.limits, limits) || !Array.isArray(state.calls) || state.calls.length > limits.maxModelCalls) throw new Error("Invalid shared budget journal or changed limits");
  const ids = new Set<string>();
  for (const call of state.calls) {
    resourceId(call.id, "model call id"); validateReservation(call.reservation, limits);
    if (ids.has(call.id) || !["pending", "settled", "unknown"].includes(call.status)) throw new Error("Invalid shared budget call");
    ids.add(call.id);
    if (call.status === "settled") {
      const actual = usageTotals(call.usage, limits);
      if (call.totalTokens !== actual.totalTokens || call.costUsd !== actual.costUsd) throw new Error("Inconsistent shared budget usage");
    }
  }
}
