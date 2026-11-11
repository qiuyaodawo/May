import type { ContextSnapshot } from "./context.js";
import { ModelProtocolError, ModelResponseValidationError, RunCancelledError, RunCheckpointError } from "./errors.js";
import type { MayEventPayload } from "./events.js";
import { runtimeHooks, type HookContext, type HookDefinition } from "./hooks.js";
import type { Model, ModelRequest, ModelResponseFormat } from "./model.js";
import { omitUndefined } from "./omit-undefined.js";
import type { UsageCost } from "./pricing.js";
import type { ModelRequestObservation, ModelRequestSink } from "./request-recording.js";
import { modelConfigurationTraceAttributes, usageTraceAttributes } from "./run-tracing.js";
import { createModelAttemptObserver } from "./telemetry.js";
import type { ToolRegistry } from "./tool-registry.js";
import { addTraceEvent, setTraceAttributes, traceError, type TraceSpan, type Tracer } from "./tracing.js";
import { textContent, type AssistantMessage, type Message, type Usage } from "./types.js";

export interface ModelStepHost {
  readonly model: Model;
  readonly tracer: Tracer | undefined;
  observe<T>(hook: HookDefinition<T>, value: T, context: HookContext): Promise<void>;
  requireReconciliation(): void;
}

export function createModelRequest(
  snapshot: ContextSnapshot,
  tools: ToolRegistry,
  responseFormat: ModelResponseFormat | undefined,
): ModelRequest {
  const messages: Message[] = [];
  if (snapshot.instructions) {
    messages.push({ role: "system", content: textContent(snapshot.instructions) });
  }
  messages.push(...snapshot.messages);
  return omitUndefined({
    messages,
    tools: tools.definitions(),
    responseFormat: responseFormat === undefined ? undefined : structuredClone(responseFormat),
    metadata: snapshot.metadata,
  });
}

export async function consumeModel(
  host: ModelStepHost,
  request: ModelRequest,
  signal: AbortSignal,
  runId: string,
  step: number,
  modelCallId: string,
  emit: (event: MayEventPayload) => void,
  modelSpan: TraceSpan | undefined,
  recordRequest: ModelRequestSink | undefined,
): Promise<{ message: AssistantMessage; usage?: Usage; cost?: UsageCost }> {
  let completed: AssistantMessage | undefined;
  let usage: Usage | undefined;
  let cost: UsageCost | undefined;
  let responseCompleted = false;
  const started = performance.now();
  let content = false;
  let text = false;
  let attempts = 0;
  let retryWaitMs = 0;
  const observer = createModelAttemptObserver(
    omitUndefined({
      tracer: host.tracer,
      parent: modelSpan?.context,
      modelCallId,
      attributes: { ...modelConfigurationTraceAttributes(host.model), "may.run.id": runId, "may.step": step },
      onRetryWait(durationMs: number) {
        retryWaitMs += durationMs;
        setTraceAttributes(modelSpan, { "may.model.retry_wait_ms": retryWaitMs });
      },
      onContent(kind: "text" | "reasoning" | "tool" | "other") {
        if (!content) {
          content = true;
          setTraceAttributes(modelSpan, { "may.model.first_content_ms": performance.now() - started });
        }
        if (kind === "text" && !text) {
          text = true;
          setTraceAttributes(modelSpan, { "may.model.first_text_ms": performance.now() - started });
        }
      },
    }),
  );
  const attemptObserver = {
    retryWait(durationMs: number) {
      observer.retryWait?.(durationMs);
    },
    start(attempt: number) {
      attempts += 1;
      return observer.start(attempt);
    },
  };
  let singleAttempt: ReturnType<typeof attemptObserver.start> | undefined;
  const streamOptions = omitUndefined({
    signal,
    runId,
    step,
    modelCallId,
    attemptObserver,
    recordRequest:
      recordRequest === undefined
        ? undefined
        : async (event: ModelRequestObservation) => {
            try {
              await recordRequest({ ...event, runId, step, modelCallId });
            } catch (error) {
              host.requireReconciliation();
              throw new RunCheckpointError(error);
            }
          },
    traceContext: modelSpan?.context,
  });
  try {
    await host.model.preflight?.(request, streamOptions);
    singleAttempt = host.model.reportsAttempts === true ? undefined : attemptObserver.start(1);
    for await (const event of host.model.stream(request, streamOptions)) {
      if (event.type === "response.completed") {
        if (responseCompleted) throw new ModelProtocolError("Model emitted more than one response.completed event");
        responseCompleted = true;
        usage = event.usage;
        cost = event.cost;
      }
      if (signal.aborted) {
        const reason =
          typeof signal.reason === "string"
            ? signal.reason
            : signal.reason instanceof Error
              ? signal.reason.message
              : undefined;
        throw new RunCancelledError(reason);
      }
      await host.observe(runtimeHooks.modelEvent, event, { runId, step, signal });
      if (event.type === "server_tool.updated") {
        singleAttempt?.content("tool");
        emit({ type: "model.server_tool.updated", step, call: event.call });
        continue;
      }
      if (event.type === "text.delta") {
        if (event.delta.length > 0) singleAttempt?.content("text");
        emit({ type: "model.text.delta", step, delta: event.delta });
        continue;
      }
      if (event.type === "reasoning.delta") {
        if (event.delta.length > 0) singleAttempt?.content("reasoning");
        emit({ type: "model.reasoning.delta", step, delta: event.delta });
        continue;
      }
      if (event.type === "retrying") {
        addTraceEvent(
          modelSpan,
          "may.model.retry",
          omitUndefined({
            "may.model.retry.attempt": event.attempt,
            "may.model.retry.max_attempts": event.maxAttempts,
            "may.model.retry.delay_ms": event.delayMs,
            "error.type": event.error.name,
            "error.code": event.error.code,
          }),
        );
        emit({
          type: "model.retrying",
          step,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          error: event.error,
        });
        continue;
      }
      completed = event.message;
      if (completed.content.some((part) => part.type === "text" && part.text.length > 0))
        singleAttempt?.content("text");
      if ((completed.toolCalls?.length ?? 0) > 0) singleAttempt?.content("tool");
      if (completed.content.some((part) => part.type !== "text")) singleAttempt?.content("other");
    }
    if (!completed) throw new ModelProtocolError("Model stream ended without a response.completed event");
    singleAttempt?.end(omitUndefined({ status: "ok", completed: true, usage }));
    return omitUndefined({ message: completed, usage, cost });
  } catch (error) {
    let failure = error;
    if (error instanceof ModelResponseValidationError) {
      usage = error.usage ?? usage;
      cost = error.cost ?? cost;
      responseCompleted = error.responseCompleted;
      if (error.usage !== usage || error.cost !== cost)
        failure = new ModelResponseValidationError(error.message, omitUndefined({ usage, cost, cause: error }));
    } else if (responseCompleted) {
      failure = new ModelResponseValidationError(
        "Model response processing failed after completion",
        omitUndefined({ usage, cost, cause: error }),
      );
    }
    singleAttempt?.end(
      omitUndefined({
        status: signal.aborted ? "cancelled" : "error",
        error: traceError(failure),
        completed: responseCompleted,
        usage,
      }),
    );
    throw failure;
  } finally {
    setTraceAttributes(modelSpan, {
      ...modelConfigurationTraceAttributes(host.model),
      "may.model.has_content": content,
      "may.model.has_text": text,
      "may.model.attempts": attempts,
      "may.model.usage_available": usage !== undefined,
      ...usageTraceAttributes(usage, "may.model"),
      "may.model.completed": responseCompleted,
    });
  }
}
