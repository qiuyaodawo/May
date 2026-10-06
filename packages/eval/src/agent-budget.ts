import { randomUUID } from "node:crypto";
import {
  FatalToolExecutionError, MayError, ModelResponseValidationError, RunBudgetMeter, RunBudgetExceededError, directToolExecutor, priceUsage, resolveUsageTotals,
  type Model, type ModelEvent, type RunBudget, type Tool, type ToolExecutor,
} from "@may/core";
import type { EvalTelemetryCollector } from "./telemetry.js";

export class EvalTrialBudget {
  private meter: RunBudgetMeter;
  private boundModels = 0;
  private boundTools = 0;
  private started = false;
  private failure: unknown;
  private readonly guardedModels = new Set<string>();
  private readonly guardedTools = new Set<string>();
  private readonly executedTools = new Set<string>();

  constructor(readonly limits: Readonly<RunBudget>, private readonly telemetry: EvalTelemetryCollector) {
    this.meter = new RunBudgetMeter(limits);
  }

  get error(): unknown { return this.failure; }
  snapshot() { return this.meter.snapshot(); }
  start(): void {
    if (this.started) throw new Error("Evaluation trial budget already started");
    this.started = true;
    this.meter = new RunBudgetMeter(this.limits);
  }

  assertBound(): void {
    if (this.boundModels === 0) throw new Error("Evaluation factory must bind its Models through budget.wrapModel");
    if (this.limits.maxToolCalls !== undefined && this.boundTools === 0) throw new Error("Evaluation factory must bind its Tools through budget.wrapTools or budget.wrapToolExecutor");
  }

  assertCanStartModel(): void {
    this.meter.checkTime();
    const snapshot = this.meter.snapshot();
    for (const [dimension, limit, consumed] of [["modelCalls", this.limits.maxModelCalls, snapshot.modelCalls],
      ["steps", this.limits.maxSteps, snapshot.steps], ["totalTokens", this.limits.maxTotalTokens, snapshot.totalTokens],
      ["costUsd", this.limits.maxCostUsd, snapshot.costUsd]] as const) {
      if (limit !== undefined && consumed >= limit) {
        const error = new RunBudgetExceededError(dimension, limit, consumed);
        this.failure = error;
        throw error;
      }
    }
  }

  verifyCoverage(): void {
    const trackedModels = this.telemetry.modelCallIds();
    const missedModel = trackedModels.find(id => !this.guardedModels.has(id));
    const missedTool = this.telemetry.successfulToolCallIds().find(id => !this.guardedTools.has(id));
    if (missedModel !== undefined || missedTool !== undefined || this.meter.snapshot().modelCalls > 0 && trackedModels.length === 0) {
      this.failure = new MayError("EVAL_BUDGET_INSTRUMENTATION_INCOMPLETE", "Evaluation factory must use the supplied tracer and guard all model/tool executions");
      this.telemetry.markIncomplete("budget-instrumentation-incomplete");
    }
  }

  wrapModel(model: Model): Model {
    this.boundModels += 1;
    const budget = this;
    return {
      get limits() { return model.limits; }, reportsAttempts: true,
      get capabilityVersion() { return model.capabilityVersion; }, get configuration() { return model.configuration; },
      async preflight(request, options) {
        if (options.modelCallId === undefined) throw new Error("Evaluation trial requires a stable modelCallId");
        budget.guardedModels.add(options.modelCallId);
        budget.assertCanStartModel();
        await model.preflight?.(request, options);
      },
      ...(model.contextCompactor === undefined ? {} : { contextCompactor: {
        name: model.contextCompactor.name,
        async compact(snapshot, options) {
          budget.startModel();
          const callId = `${options.runId ?? "compaction"}:compact:${randomUUID()}`;
          budget.guardedModels.add(callId);
          const span = budget.telemetry.tracer.startSpan("may.model.call", { attributes: {
            "may.model.call_id": callId, "may.model.attempts_complete": false,
          } });
          try {
            const result = await model.contextCompactor!.compact(snapshot, options);
            const cost = priceUsage(result.usage, budget.limits.pricing ?? budget.limits.tokenPrices, budget.limits.usagePricer);
            budget.telemetry.recordModelReceipt(callId, result.usage, cost);
            span.setAttributes({ "may.model.usage_complete": resolveUsageTotals(result.usage).complete,
              ...(result.usage?.inputTokens === undefined ? {} : { "may.model.input_tokens": result.usage.inputTokens }),
              ...(result.usage?.outputTokens === undefined ? {} : { "may.model.output_tokens": result.usage.outputTokens }),
              ...(result.usage?.totalTokens === undefined ? {} : { "may.model.total_tokens": result.usage.totalTokens }),
              "may.model.currency": cost.currency, "may.model.cost_kind": cost.kind, "may.model.cost_complete": cost.complete,
              ...(cost.amount === undefined ? {} : { "may.model.cost": cost.amount }),
            });
            budget.accountUsage(result.usage, cost);
            span.end();
            return result;
          } catch (error) { span.end({ status: "error" }); throw error; }
        },
      } }),
      async *stream(request, options): AsyncIterable<ModelEvent> {
        if (options.modelCallId === undefined) throw new Error("Evaluation trial requires a stable modelCallId");
        budget.guardedModels.add(options.modelCallId);
        budget.startModel();
        const attempt = model.reportsAttempts === true ? undefined : options.attemptObserver?.start(1);
        let settled = false;
        try {
          for await (const event of model.stream(request, options)) {
            if (event.type === "text.delta" && event.delta.length > 0) attempt?.content("text");
            if (event.type === "reasoning.delta" && event.delta.length > 0) attempt?.content("reasoning");
            if (event.type === "response.completed") {
              if (settled) throw new Error("Model emitted multiple response receipts");
              settled = true;
              if ((event.message.toolCalls?.length ?? 0) > 0) attempt?.content("tool");
              attempt?.end({ status: "ok", completed: true, ...(event.usage === undefined ? {} : { usage: event.usage }) });
              const cost = event.cost ?? priceUsage(event.usage, budget.limits.pricing ?? budget.limits.tokenPrices, budget.limits.usagePricer);
              budget.telemetry.recordModelReceipt(options.modelCallId, event.usage, cost);
              try { budget.accountUsage(event.usage, cost); }
              catch (error) { throw new EvalBudgetResponseError(error, event.usage, cost); }
              try { budget.reserveToolRequests((event.message.toolCalls ?? []).map(call => `${options.runId}:${options.step}:${call.id}`)); }
              catch (error) { throw new EvalBudgetResponseError(error, event.usage, cost); }
              yield { ...event, cost };
            } else yield event;
          }
        } catch (error) {
          attempt?.end({ status: options.signal.aborted ? "cancelled" : "error",
            ...(error instanceof Error ? { error: { name: error.name, ...( "code" in error && typeof error.code === "string" ? { code: error.code } : {}) } } : {}),
            ...(error instanceof ModelResponseValidationError ? { completed: true, ...(error.usage === undefined ? {} : { usage: error.usage }) } : {}) });
          if (!settled && error instanceof ModelResponseValidationError) {
            settled = true;
            budget.telemetry.recordModelReceipt(options.modelCallId, error.usage, error.cost);
            try { budget.accountUsage(error.usage, error.cost); }
            catch (accountingError) { throw new EvalBudgetResponseError(accountingError, error.usage, error.cost); }
          }
          throw error;
        } finally {
          attempt?.end({ status: options.signal.aborted ? "cancelled" : settled ? "ok" : "error", completed: settled });
        }
      },
    };
  }

  wrapTools(tools: Iterable<Tool>): readonly Tool[] {
    const executor = this.wrapToolExecutor();
    return [...tools].map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
      ...(tool.permissionVersion === undefined ? {} : { permissionVersion: tool.permissionVersion }),
      ...(tool.parse === undefined ? {} : { parse: tool.parse.bind(tool) }),
      ...(tool.resultContent === undefined ? {} : { resultContent: tool.resultContent.bind(tool) }),
      execute: (input, context) => executor.execute({ tool, input, context }) }));
  }

  wrapToolExecutor(executor: ToolExecutor = directToolExecutor): ToolExecutor {
    this.boundTools += 1;
    const budget = this;
    return {
      async execute(execution) {
        const id = `${execution.context.runId}:${execution.context.step}:${execution.context.toolCallId}`;
        try {
          if (budget.executedTools.has(id)) throw new MayError("EVAL_TOOL_EXECUTION_DUPLICATE", "Evaluation tool execution identity was already used");
          budget.reserveToolRequests([id]);
          budget.executedTools.add(id);
        }
        catch (error) {
          budget.failure = error;
          throw new FatalToolExecutionError("Evaluation trial tool budget exceeded", { code: code(error), cause: error });
        }
        return executor.execute(execution);
      },
    };
  }

  private startModel(): void {
    if (!this.started) throw new Error("Evaluation trial budget has not started");
    try { this.meter.startModel(this.meter.snapshot().modelCalls + 1); }
    catch (error) { this.failure = error; throw error; }
  }

  private reserveToolRequests(ids: readonly string[]): void {
    const newIds = ids.filter(id => !this.guardedTools.has(id));
    if (new Set(newIds).size !== newIds.length) throw new MayError("EVAL_TOOL_REQUEST_DUPLICATE", "Model returned duplicate tool request identities");
    if (newIds.length === 0) return;
    try { this.meter.reserveTools(newIds.length); }
    catch (error) { this.failure = error; throw error; }
    for (const id of newIds) this.guardedTools.add(id);
  }

  private accountUsage(...arguments_: Parameters<RunBudgetMeter["recordUsage"]>): void {
    try { this.meter.recordUsage(...arguments_); }
    catch (error) { this.failure = error; throw error; }
  }
}

class EvalBudgetResponseError extends ModelResponseValidationError {
  override readonly code: string;
  constructor(error: unknown, usage: import("@may/core").Usage | undefined, cost: import("@may/core").UsageCost | undefined) {
    super("Evaluation trial model budget stopped execution", { cause: error,
      ...(usage === undefined ? {} : { usage }), ...(cost === undefined ? {} : { cost }) });
    this.code = code(error);
  }
}

function code(error: unknown) { return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "EVAL_BUDGET_FAILED"; }
