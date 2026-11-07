import { omitUndefined, type AgentRuntime, type Message, type HookDispatcher } from "../core/index.js";
import type { PermissionToolExecutor } from "../permissions/index.js";
import { Session, type SessionRuntimeInfo } from "../session/index.js";
import { SKILL_STATE_KEY } from "../skills/index.js";
import type { AgentApplicationOptions } from "./application.js";
import { applicationHooks } from "./hooks.js";
import { PLUGIN_STATE_KEY } from "./plugins.js";
import { resumeSession } from "./session-navigation.js";

export async function openApplicationSession(
  options: AgentApplicationOptions,
  sessionId: string,
  transformForkState: (key: string, value: unknown) => unknown,
  createRuntime: (messages?: Message[], info?: SessionRuntimeInfo) => Promise<AgentRuntime>,
  releasePendingRuntime: () => void,
): Promise<Session> {
  return options.fork !== undefined
    ? await Session.fork({
        sourceId: options.fork.sessionId,
        positionSeq: options.fork.positionSeq,
        requestRecording: options.requestRecording ?? "required",
        providerBodyRecording: options.providerBodyRecording,
        id: sessionId,
        store: options.store,
        deferBranchPositions: true,
        deferForkReady: true,
        stateKeys: [SKILL_STATE_KEY, PLUGIN_STATE_KEY, ...(options.forkStateKeys ?? [])],
        transformState: transformForkState,
        ...omitUndefined({ metadata: options.metadata === undefined ? undefined : { ...options.metadata } }),
        createRuntime: async (messages, info) => {
          const runtime = await createRuntime(messages, info);
          releasePendingRuntime();
          return runtime;
        },
      })
    : options.resume === true
      ? await resumeSession(options, async (messages, info) => {
          const runtime = await createRuntime(messages, info);
          releasePendingRuntime();
          return runtime;
        })
      : await Session.create({
          requestRecording: options.requestRecording ?? "required",
          providerBodyRecording: options.providerBodyRecording,
          runtime: await createRuntime(),
          store: options.store,
          deferBranchPositions: true,
          ...omitUndefined({
            metadata: options.metadata === undefined ? undefined : { ...options.metadata },
            id: options.sessionId,
          }),
        });
}

export async function validateOpenedSession(options: AgentApplicationOptions, session: Session): Promise<void> {
  try {
    await options.validateSession?.(session.metadata);
  } catch (error) {
    if (options.resume !== true && options.fork === undefined) await options.store?.delete?.(session.id);
    throw error;
  }
}

export function connectPermissionEvents(
  permissions: PermissionToolExecutor,
  session: Session,
  hooks: HookDispatcher,
  sessionId: string,
): void {
  permissions.setEventSink(async (event) => {
    await session.recordPermissionEvent(event);
    const payload =
      event.type === "approval.requested"
        ? {
            ...event,
            request: {
              ...event.request,
              context: omitUndefined({
                runId: event.request.context.runId,
                step: event.request.context.step,
                toolCallId: event.request.context.toolCallId,
                idempotencyKey: event.request.context.idempotencyKey,
                scope: event.request.context.scope,
                traceContext: event.request.context.traceContext,
              }),
            },
          }
        : event;
    if (
      event.type === "approval.requested" ||
      event.type === "approval.resolved" ||
      event.type === "approval.cancelled"
    ) {
      await hooks.observe(
        event.type === "approval.requested" ? applicationHooks.approvalRequested : applicationHooks.approvalResolved,
        payload,
        { signal: new AbortController().signal, sessionId },
      );
    }
  });
}
