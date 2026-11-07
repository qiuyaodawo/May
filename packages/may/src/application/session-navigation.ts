import type { AgentRuntime, Message } from "../core/index.js";
import { Session, type SessionEvent, type SessionRuntimeInfo, type SessionStore } from "../session/index.js";
import type { AgentApplicationFork, AgentApplicationOptions } from "./application.js";
import type { ApplicationPluginState } from "./plugins.js";

export async function resumeSession(
  options: AgentApplicationOptions,
  createRuntime: (messages?: Message[], runtimeInfo?: SessionRuntimeInfo) => Promise<AgentRuntime>,
): Promise<Session> {
  if (options.sessionId === undefined) {
    throw new Error("sessionId is required when resuming a session");
  }
  return Session.resume({
    requestRecording: options.requestRecording ?? "required",
    providerBodyRecording: options.providerBodyRecording,
    id: options.sessionId,
    store: options.store,
    deferBranchPositions: true,
    createRuntime: (messages, info) => createRuntime(messages, info),
  });
}

export function latestRunFailed(history: readonly SessionEvent[]): boolean {
  for (let index = history.length - 1; index >= 0; index--) {
    const event = history[index]!;
    if (event.type === "run.failed" || event.type === "run.interrupted") return true;
    if (event.type === "run.completed" || event.type === "run.yielded" || event.type === "run.cancelled") {
      return false;
    }
  }
  return false;
}

export async function inspectForkHistory(
  store: SessionStore,
  fork: AgentApplicationFork,
): Promise<readonly SessionEvent[]> {
  if (store.inspect === undefined) throw new Error("Session forking requires read-only store inspection");
  const history = await store.inspect(fork.sessionId);
  const position = history.find((event) => event.seq === fork.positionSeq);
  if (position?.type !== "run.settled") throw new Error("Selected history position has no recoverable state");
  return history.slice(0, fork.positionSeq);
}

export function filterForkPluginState(
  state: ApplicationPluginState,
  pluginIds: readonly string[] = [],
): ApplicationPluginState {
  const allowed = new Set(["may.skills", ...pluginIds]);
  const select = (snapshot: ApplicationPluginState["application"]) =>
    Object.fromEntries(
      Object.entries(snapshot)
        .filter(([id]) => allowed.has(id))
        .map(([id, value]) => [id, structuredClone(value)]),
    );
  return { version: 1, application: select(state.application), session: select(state.session) };
}
