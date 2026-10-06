import type { CoordinationRuntime, CoordinationSnapshot } from "@may/coordination";
import type { Tracer } from "@may/core";
import type { EvalExecutionAdapter, EvalExecutionResult, ExecutionCreateContext } from "./types.js";
import { type EvalApprovalHandler, errorCode, waitWithSignal } from "./application.js";
import { EvalTelemetryCollector, evalIdentities, evalMetrics } from "./telemetry.js";
import { EvalTrialBudget } from "./agent-budget.js";

export interface CoordinationExecutionAdapterOptions {
  readonly id?: string;
  readonly version: string;
  readonly create: (bindings: { readonly context: ExecutionCreateContext; readonly tracer: Tracer; readonly budget: EvalTrialBudget }) => Promise<CoordinationRuntime>;
  readonly outputTaskId?: string;
  readonly approvals?: EvalApprovalHandler;
}

export { EvalTrialBudget } from "./agent-budget.js";

export function createCoordinationExecutionAdapter(options: CoordinationExecutionAdapterOptions): EvalExecutionAdapter {
  if (!options.version.trim()) throw new TypeError("Coordination adapter version is required");
  return {
    id: options.id ?? "coordination", version: options.version,
    async create(context) {
      context.signal.throwIfAborted();
      const telemetry = new EvalTelemetryCollector(context.runBudget);
      const budget = new EvalTrialBudget(context.runBudget, telemetry);
      const runtime = await options.create({ context, tracer: telemetry.tracer, budget });
      try { budget.assertBound(); }
      catch (error) { await runtime.close(); throw error; }
      const initial = runtime.snapshot();
      if (initial.startedAt !== undefined || initial.tasks.some(task => task.status !== "queued" || (task.turn ?? 0) !== 0)) {
        await runtime.close();
        throw new Error("Evaluation requires a fresh CoordinationRuntime");
      }
      if (options.outputTaskId !== undefined && !initial.tasks.some(task => task.id === options.outputTaskId)) {
        await runtime.close();
        throw new Error("Evaluation outputTaskId is absent from the coordination graph");
      }
      let activeSignal = context.signal;
      let interactionUnavailable = false;
      let relayError: unknown;
      let execution: Promise<EvalExecutionResult> | undefined;
      let cancelOperation: Promise<void> | undefined;
      const cancelRuntime = () => {
        cancelOperation ??= runtime.cancel(`${context.trial.id}:cancel`);
        return cancelOperation;
      };
      const relay = (async () => {
        for await (const event of runtime.events) {
          if (event.type === "runtime.failed") throw new Error("Evaluation coordination runtime failed");
          if (event.type !== "agent.event") continue;
          telemetry.observe(event.event, event.sessionId);
          const applicationEvent = event.event;
          if (applicationEvent.type !== "permission.event" || applicationEvent.event.type !== "approval.requested") continue;
          if (options.approvals === undefined) {
            interactionUnavailable = true;
            await cancelRuntime();
            continue;
          }
          if (options.approvals.assisted === true) telemetry.recordHumanIntervention();
          const decision = await waitWithSignal(Promise.resolve(options.approvals.decide(applicationEvent.event.request, activeSignal)), activeSignal);
          if (!await runtime.resolveApproval(event.taskId, applicationEvent.event.request.id, decision)) throw new Error("Evaluation coordination approval is no longer pending");
        }
      })().catch(async error => {
        relayError = error;
        try { await cancelRuntime(); }
        catch (cancelError) { relayError = new AggregateError([error, cancelError], "Coordination event handling and cancellation failed"); }
      });
      const confirmed = (snapshot: CoordinationSnapshot) => snapshot.tasks.every(task => ["completed", "failed", "cancelled"].includes(task.status));
      const runTrial = async (signal: AbortSignal): Promise<EvalExecutionResult> => {
        activeSignal = signal;
        budget.start();
        let failure: unknown;
        const abort = () => { void cancelRuntime().catch(error => { relayError ??= error; }); };
        signal.addEventListener("abort", abort, { once: true });
        try {
          signal.throwIfAborted();
          await runtime.wait();
        } catch (error) {
          failure = error;
        } finally {
          signal.removeEventListener("abort", abort);
          await cancelOperation;
          await runtime.close();
          await relay;
        }
        const snapshot = runtime.snapshot();
        const terminationConfirmed = confirmed(snapshot);
        let status: EvalExecutionResult["status"] = snapshot.tasks.every(task => task.status === "completed") ? "completed" : "failed";
        let reason: string | undefined;
        if (!terminationConfirmed) reason = snapshot.tasks.some(task => task.status === "recovery-required") ? "termination-unconfirmed" : "interaction-unavailable";
        if (snapshot.stopReason?.includes("deadline")) { status = "limited"; reason = "coordination-duration-limit"; }
        else if (signal.aborted) { status = "cancelled"; reason = "cancelled"; }
        else if (interactionUnavailable) { status = "failed"; reason = "interaction-unavailable"; }
        else if (failure !== undefined) { status = "failed"; reason = errorCode(failure); }
        if (relayError !== undefined && !signal.aborted) { status = "failed"; reason = errorCode(relayError); }
        budget.verifyCoverage();
        if (budget.error !== undefined) {
          reason = errorCode(budget.error);
          status = reason === "RUN_BUDGET_EXCEEDED" || reason === "MAX_STEPS_EXCEEDED" ? "limited" : "failed";
        }
        await telemetry.flush(context.emit);
        const identities = { ...evalIdentities(telemetry.identities()), coordinationIds: [snapshot.id],
          sessionIds: [...new Set([...telemetry.identities().sessionIds, ...snapshot.tasks.map(task => task.sessionId)])] };
        const evidence = await context.evidenceSink.write({ id: "coordination-telemetry", mediaType: "application/json",
          content: JSON.stringify({ identities, metrics: telemetry.metrics(), budget: budget.snapshot(), spans: telemetry.evidence(), approvals: telemetry.approvalEvidence(),
            relayFailure: relayError === undefined ? null : errorCode(relayError),
            tasks: snapshot.tasks.map(task => ({ id: task.id, agent: task.agent, status: task.status, turn: task.turn ?? 0,
              sessionId: task.sessionId, parentTaskId: task.parentTaskId })) }) });
        const outputTask = options.outputTaskId === undefined ? undefined : snapshot.tasks.find(task => task.id === options.outputTaskId);
        return { status, terminationConfirmed, identities, metrics: evalMetrics(telemetry.metrics()), evidence: [evidence],
          ...(reason === undefined ? {} : { reason }),
          output: outputTask === undefined
            ? { tasks: snapshot.tasks.map(task => ({ id: task.id, status: task.status, ...(task.output === undefined ? {} : { text: task.output.text }) })) }
            : outputTask.output === undefined ? null : { text: outputTask.output.text },
        };
      };
      return {
        execute(signal) {
          if (execution !== undefined) throw new Error("Evaluation coordination execution already started");
          execution = runTrial(signal);
          return execution;
        },
        async cancel(signal) {
          await waitWithSignal(cancelRuntime(), signal);
          await waitWithSignal(runtime.close(), signal);
          await waitWithSignal(relay, signal);
          if (execution !== undefined) await waitWithSignal(execution, signal);
          return { confirmed: confirmed(runtime.snapshot()) };
        },
        async close(signal) {
          await waitWithSignal(runtime.close(), signal);
          await waitWithSignal(relay, signal);
          if (execution !== undefined) await waitWithSignal(execution, signal);
        },
      };
    },
  };
}
