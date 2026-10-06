import type { AgentApplication, AgentRun } from "@may/application";
import type { ApprovalDecision, ApprovalRequest } from "@may/permissions";
import type { RunResult, Tracer, UserMessage } from "@may/core";
import type { EvalExecutionAdapter, EvalExecutionResult, ExecutionCreateContext, JsonValue } from "./types.js";
import { assertJson } from "./validation.js";
import { EvalTelemetryCollector, evalIdentities, evalMetrics } from "./telemetry.js";
import { EvalTrialBudget } from "./agent-budget.js";

export interface EvalApprovalHandler {
  readonly assisted?: boolean;
  decide(request: ApprovalRequest, signal: AbortSignal): ApprovalDecision | Promise<ApprovalDecision>;
}

export interface ApplicationExecutionAdapterOptions {
  readonly id?: string;
  readonly version: string;
  readonly open: (bindings: { readonly context: ExecutionCreateContext; readonly tracer: Tracer; readonly budget: EvalTrialBudget }) => Promise<AgentApplication>;
  readonly input?: (context: ExecutionCreateContext) => readonly UserMessage[];
  readonly approvals?: EvalApprovalHandler;
  readonly continueAfterYield?: (bindings: { readonly context: ExecutionCreateContext; readonly application: AgentApplication; readonly result: RunResult }) => boolean | Promise<boolean>;
  readonly maxContinuations?: number;
}

export function createApplicationExecutionAdapter(options: ApplicationExecutionAdapterOptions): EvalExecutionAdapter {
  const maxContinuations = options.maxContinuations ?? 32;
  if (!Number.isSafeInteger(maxContinuations) || maxContinuations < 0) throw new RangeError("maxContinuations must be a non-negative safe integer");
  if (!options.version.trim()) throw new TypeError("Application adapter version is required");
  return {
    id: options.id ?? "application", version: options.version,
    validateCase({ case: evalCase }) {
      if (options.input === undefined && evalCase.input.some(message => message.role !== "user")) throw new TypeError("Application eval input requires user messages or an explicit input mapper");
    },
    async create(context) {
      context.signal.throwIfAborted();
      const inputs = options.input === undefined ? context.case.input as readonly UserMessage[] : options.input(context);
      if (inputs.length === 0 || inputs.some(message => message.role !== "user")) throw new TypeError("Application input mapper must return non-empty user messages");
      const telemetry = new EvalTelemetryCollector(context.runBudget);
      const budget = new EvalTrialBudget(context.runBudget, telemetry);
      const application = await options.open({ context, tracer: telemetry.tracer, budget });
      try { budget.assertBound(); }
      catch (error) { await application.close(); throw error; }
      if ((await application.history()).some(event => event.type === "input.submitted" || event.type === "run.started")) {
        await application.close();
        throw new Error("Evaluation requires a fresh Application Session");
      }
      let activeRun: AgentRun | undefined;
      let execution: Promise<EvalExecutionResult> | undefined;
      let relayError: unknown;
      let interactionUnavailable = false;
      let activeSignal = context.signal;
      const relay = (async () => {
        for await (const event of application.events) {
          telemetry.observe(event, application.sessionId);
          if (event.type !== "permission.event" || event.event.type !== "approval.requested") continue;
          if (options.approvals === undefined) {
            interactionUnavailable = true;
            application.cancel("Evaluation approval handler is unavailable");
            continue;
          }
          if (options.approvals.assisted === true) telemetry.recordHumanIntervention();
          const decision = await waitWithSignal(Promise.resolve(options.approvals.decide(event.event.request, activeSignal)), activeSignal);
          activeSignal.throwIfAborted();
          if (!await application.resolveApproval(event.event.request.id, decision)) throw new Error("Evaluation approval is no longer pending");
        }
      })().catch(error => { relayError = error; application.cancel("Evaluation event consumer failed"); });
      const terminated = () => !application.isRunning && application.listRecoveries().length === 0;
      const runTrial = async (signal: AbortSignal): Promise<EvalExecutionResult> => {
        activeSignal = signal;
        budget.start();
        let result: RunResult | undefined;
        let failure: unknown;
        let reason: string | undefined;
        let status: EvalExecutionResult["status"] = "completed";
        const cancel = () => application.cancel("Evaluation cancelled");
        signal.addEventListener("abort", cancel, { once: true });
        try {
          signal.throwIfAborted();
          for (const [index, input] of inputs.entries()) {
            budget.assertCanStartModel();
            activeRun = await application.submit({ input, inputId: `${context.trial.id}:input:${index}`, signal,
              runBudget: context.runBudget, traceAttributes: { "may.task.id": context.trial.id } });
            result = await activeRun.result;
            let continuations = 0;
            while (result.finishReason === "yielded") {
              if (continuations >= maxContinuations || options.continueAfterYield === undefined ||
                !await options.continueAfterYield({ context, application, result })) {
                status = "failed";
                reason = "yielded-without-continuation";
                break;
              }
              signal.throwIfAborted();
              budget.assertCanStartModel();
              continuations += 1;
              activeRun = await application.continue({ signal, runBudget: context.runBudget, traceAttributes: { "may.task.id": context.trial.id } });
              result = await activeRun.result;
            }
            if (status !== "completed") break;
          }
        } catch (error) {
          failure = error;
          const code = errorCode(error);
          status = code === "RUN_BUDGET_EXCEEDED" || code === "MAX_STEPS_EXCEEDED" ? "limited" : signal.aborted ? "cancelled" : "failed";
          reason = code;
        } finally {
          signal.removeEventListener("abort", cancel);
          activeRun = undefined;
          await application.close();
          await relay;
        }
        if (relayError !== undefined && !signal.aborted) { status = "failed"; reason = errorCode(relayError); }
        if (interactionUnavailable) { status = "failed"; reason = "interaction-unavailable"; }
        budget.verifyCoverage();
        if (budget.error !== undefined) {
          reason = errorCode(budget.error);
          status = reason === "RUN_BUDGET_EXCEEDED" || reason === "MAX_STEPS_EXCEEDED" ? "limited" : "failed";
        }
        await telemetry.flush(context.emit);
        const evidence = await context.evidenceSink.write({ id: "application-telemetry", mediaType: "application/json",
          content: JSON.stringify({ identities: telemetry.identities(), metrics: telemetry.metrics(), budget: budget.snapshot(), spans: telemetry.evidence(), approvals: telemetry.approvalEvidence(),
            relayFailure: relayError === undefined ? null : errorCode(relayError) }) });
        return { status, terminationConfirmed: terminated(),
          ...(result === undefined ? {} : { output: applicationOutput(result) }),
          ...(reason === undefined && failure === undefined ? {} : { reason: reason ?? errorCode(failure) }),
          identities: evalIdentities(telemetry.identities()), metrics: evalMetrics(telemetry.metrics()), evidence: [evidence] };
      };
      return {
        execute(signal) {
          if (execution !== undefined) throw new Error("Evaluation Application execution already started");
          execution = runTrial(signal);
          return execution;
        },
        async cancel(signal) {
          activeRun?.cancel("Evaluation cancelled");
          application.cancel("Evaluation cancelled");
          await waitWithSignal(application.close(), signal);
          await waitWithSignal(relay, signal);
          if (execution !== undefined) await waitWithSignal(execution, signal);
          return { confirmed: terminated() };
        },
        async close(signal) {
          await waitWithSignal(application.close(), signal);
          await waitWithSignal(relay, signal);
          if (execution !== undefined) await waitWithSignal(execution, signal);
        },
      };
    },
  };
}

export { EvalTrialBudget } from "./agent-budget.js";

function applicationOutput(result: RunResult): JsonValue {
  const text = result.message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  const json = result.message.content.filter(part => part.type === "json").map(part => { assertJson(part.value); return part.value; });
  return { ...(text.length === 0 ? {} : { text }), ...(json.length === 0 ? {} : { json }) };
}

export function errorCode(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.name : "unknown";
}

export async function waitWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { if (abort !== undefined) signal.removeEventListener("abort", abort); }
}
