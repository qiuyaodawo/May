import type { CoordinationSnapshot, CoordinationTask, HandoffSpec, TaskController, TaskSpec } from "./types.js";
import {
  canonical,
  limits,
  name,
  positive,
  validateGraph,
  validateHandoff,
  validateMessage,
  validateOutput,
} from "./validation.js";

/** @experimental */
export function validateSnapshot(snapshot: CoordinationSnapshot, id: string): void {
  if (snapshot?.format !== 1 || snapshot.id !== id) throw new Error("Invalid coordination journal identity/format");
  positive(snapshot.revision, "revision");
  name(snapshot.policyVersion, "policy version");
  for (const key of ["maxConcurrent", "maxTasks", "maxOutputBytes"] as const) positive(snapshot.limits?.[key], key);
  limits(snapshot.limits);
  validateGraph(snapshot.tasks, snapshot.limits.maxTasks, snapshot.limits.maxInputBytes);
  if (snapshot.startedAt !== undefined && (!Number.isSafeInteger(snapshot.startedAt) || snapshot.startedAt < 0))
    throw new Error("Invalid start time");
  if (snapshot.stopReason !== undefined && typeof snapshot.stopReason !== "string")
    throw new Error("Invalid stop reason");
  if (!snapshot.commands || typeof snapshot.commands !== "object" || Array.isArray(snapshot.commands))
    throw new Error("Invalid command receipts");
  for (const [id, payload] of Object.entries(snapshot.commands)) {
    name(id, "command id");
    if (typeof payload !== "string") throw new Error("Invalid command receipt");
  }
  const messages = snapshot.messages ?? [];
  if (!Array.isArray(messages) || messages.length > (snapshot.limits.maxMessages ?? 1024))
    throw new Error("Invalid message log size");
  const messageIds = new Set<string>();
  for (const message of messages) {
    validateMessage(message, snapshot.limits.maxMessageBytes ?? 16_384);
    name(message.id, "message id");
    const sender = snapshot.tasks.find((task) => task.id === message.fromTaskId);
    const recipient = snapshot.tasks.find((task) => task.id === message.toTaskId);
    if (messageIds.has(message.id) || !sender || !recipient || sender.id === recipient.id)
      throw new Error("Invalid message identity");
    messageIds.add(message.id);
    if (!Number.isSafeInteger(message.fromTurn) || message.fromTurn < 0 || message.fromTurn > (sender.turn ?? 0))
      throw new Error("Invalid message sender turn");
    if (
      snapshot.commands[message.id] !==
      canonical({
        type: "send-message",
        senderId: sender.id,
        turn: message.fromTurn,
        message: { toTaskId: recipient.id, text: message.text },
      })
    )
      throw new Error("Message has no matching receipt");
    if (
      message.deliveredTurn !== undefined &&
      (!Number.isSafeInteger(message.deliveredTurn) ||
        message.deliveredTurn < 0 ||
        message.deliveredTurn > (recipient.turn ?? 0))
    )
      throw new Error("Invalid message delivery turn");
    if (message.deliveredTurn === (recipient.turn ?? 0) && !recipient.inbox?.includes(message.id))
      throw new Error("Delivered message is missing from its turn inbox");
  }
  const sessions = new Set<string>();
  const dispatches = new Set<string>();
  validateGraphHistory(snapshot, sessions, dispatches);
  for (const task of snapshot.tasks) {
    if (task.recoveryVersion !== undefined) positive(task.recoveryVersion, "recoveryVersion");
    if (!Array.isArray(task.dependsOn)) throw new Error("Missing persisted dependencies");
    if (task.cancelRequested !== undefined && typeof task.cancelRequested !== "boolean")
      throw new Error("Invalid cancellation intent");
    name(task.agentVersion, "agent version");
    name(task.sessionId, "session id");
    name(task.dispatchId, "dispatch id");
    if (sessions.has(task.sessionId) || dispatches.has(task.dispatchId))
      throw new Error("Duplicate execution identity");
    sessions.add(task.sessionId);
    dispatches.add(task.dispatchId);
    validateAttempts(task, snapshot, sessions, dispatches);
    validateTaskHandoffs(task, snapshot, sessions, dispatches);
    if (
      !["queued", "running", "waiting", "cancelling", "completed", "failed", "cancelled", "recovery-required"].includes(
        task.status,
      )
    )
      throw new Error("Invalid task status");
    if (
      task.turn !== undefined &&
      (!Number.isSafeInteger(task.turn) || task.turn < 0 || task.turn >= (snapshot.limits.maxTaskTurns ?? 16))
    )
      throw new Error("Invalid task turn");
    const ancestors = new Set([task.id]);
    let parent = task.parentTaskId;
    while (parent !== undefined) {
      if (ancestors.has(parent)) throw new Error("Parent relationships contain a cycle");
      ancestors.add(parent);
      const record = snapshot.tasks.find((task) => task.id === parent);
      if (!record) throw new Error("Unknown parent task");
      parent = record.parentTaskId;
    }
    if (ancestors.size - 1 > (snapshot.limits.maxDepth ?? 4)) throw new Error("Task nesting exceeds maxDepth");
    for (const ids of [task.waitFor, task.wakeFrom]) {
      if (ids === undefined) continue;
      if (
        !Array.isArray(ids) ||
        ids.length === 0 ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => snapshot.tasks.find((child) => child.id === id)?.parentTaskId !== task.id)
      )
        throw new Error("Waits/wakeups must reference unique direct children");
    }
    if (task.waitForMessages !== undefined && typeof task.waitForMessages !== "boolean")
      throw new Error("Invalid message wait");
    if (task.waitForMessages && task.waitFor !== undefined) throw new Error("Conflicting wait conditions");
    if (task.status === "waiting" && task.waitFor === undefined && !task.waitForMessages)
      throw new Error("Waiting task has no wait condition");
    if (
      task.inbox !== undefined &&
      (!Array.isArray(task.inbox) ||
        new Set(task.inbox).size !== task.inbox.length ||
        task.inbox.some((id) => {
          const message = messages.find((message) => message.id === id);
          return !message || message.toTaskId !== task.id || message.deliveredTurn !== (task.turn ?? 0);
        }))
    )
      throw new Error("Invalid turn inbox");
    if (
      task.wakeFrom?.some(
        (id) => !["completed", "failed", "cancelled"].includes(snapshot.tasks.find((child) => child.id === id)!.status),
      )
    )
      throw new Error("Wakeup references a nonterminal child");
    if (task.detail !== undefined && typeof task.detail !== "string") throw new Error("Invalid task detail");
    if (task.status === "completed" && task.output === undefined) throw new Error("Completed task has no output");
    if (task.output !== undefined) validateOutput(task.output, snapshot.limits.maxOutputBytes);
  }
}

function validateTaskHandoffs(
  task: CoordinationTask,
  snapshot: CoordinationSnapshot,
  sessions: Set<string>,
  dispatches: Set<string>,
): void {
  const history = task.handoffs ?? [];
  const maxHandoffs = snapshot.limits.maxHandoffs ?? 4;
  if (!Array.isArray(history) || history.length > maxHandoffs) throw new Error("Invalid handoff history size");
  const maxTurn = snapshot.limits.maxTaskTurns ?? 16;
  const current = { ...task, turn: task.turn ?? 0, sessionStartTurn: task.sessionStartTurn ?? 0 };
  const validateController = (owner: TaskController) => {
    for (const key of ["agent", "agentVersion", "sessionId", "dispatchId"] as const)
      name(owner[key], `controller ${key}`);
    if (
      !Number.isSafeInteger(owner.turn) ||
      owner.turn < 0 ||
      owner.turn >= maxTurn ||
      !Number.isSafeInteger(owner.sessionStartTurn) ||
      owner.sessionStartTurn < 0 ||
      owner.sessionStartTurn > owner.turn
    )
      throw new Error("Invalid controller turn");
  };
  const sameOwner = (a: TaskController, b: TaskController) =>
    a.agent === b.agent &&
    a.agentVersion === b.agentVersion &&
    a.sessionId === b.sessionId &&
    a.dispatchId === b.dispatchId &&
    a.sessionStartTurn === b.sessionStartTurn;
  const receipt = (commandId: string, turn: number, spec: HandoffSpec) => {
    name(commandId, "handoff command id");
    if (
      snapshot.commands[commandId] !==
      canonical({ type: "handoff", taskId: task.id, turn, handoff: { agent: spec.agent, input: spec.input } })
    )
      throw new Error("Handoff has no matching receipt");
  };
  validateController(current);
  let previous: TaskController | undefined;
  for (const entry of history) {
    validateController(entry.from);
    validateController(entry.to);
    validateHandoff({ agent: entry.to.agent, input: entry.input }, snapshot.limits.maxHandoffBytes ?? 16_384);
    receipt(entry.commandId, entry.from.turn, { agent: entry.to.agent, input: entry.input });
    if (
      entry.from.agent === entry.to.agent ||
      entry.to.turn !== entry.from.turn + 1 ||
      entry.to.sessionStartTurn !== entry.to.turn ||
      (previous
        ? !sameOwner(previous, entry.from) || entry.from.turn < previous.turn
        : entry.from.sessionStartTurn !== (task.attemptStartTurn ?? 0))
    )
      throw new Error("Invalid handoff chain");
    if (sessions.has(entry.from.sessionId) || dispatches.has(entry.from.dispatchId))
      throw new Error("Duplicate historical controller identity");
    sessions.add(entry.from.sessionId);
    dispatches.add(entry.from.dispatchId);
    previous = entry.to;
  }
  if (
    previous
      ? !sameOwner(previous, current) || current.turn < previous.turn
      : current.sessionStartTurn !== (task.attemptStartTurn ?? 0)
  )
    throw new Error("Handoff history does not match current controller");
  const pending = task.pendingHandoff;
  if (pending) {
    validateHandoff(pending, snapshot.limits.maxHandoffBytes ?? 16_384);
    name(pending.agentVersion, "handoff agent version");
    receipt(pending.commandId, current.turn, pending);
    if (
      history.length >= maxHandoffs ||
      current.turn + 1 >= maxTurn ||
      pending.agent === task.agent ||
      task.waitFor?.length ||
      task.waitForMessages ||
      !["running", "cancelling", "recovery-required", "failed", "cancelled"].includes(task.status)
    )
      throw new Error("Invalid pending handoff");
    if (snapshot.messages?.some((message) => message.toTaskId === task.id && message.deliveredTurn === undefined))
      throw new Error("Pending handoff contains unreceived messages");
  }
}

function validateAttempts(
  task: CoordinationTask,
  snapshot: CoordinationSnapshot,
  sessions: Set<string>,
  dispatches: Set<string>,
): void {
  const attempts = task.attempts ?? [];
  if (
    !Array.isArray(attempts) ||
    attempts.length !== (task.attempt ?? 0) ||
    attempts.length >= (snapshot.limits.maxAttempts ?? 3)
  )
    throw new Error("Invalid task attempt history size");
  const start = task.attemptStartTurn ?? 0;
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    start > (task.sessionStartTurn ?? 0) ||
    (!attempts.length && start !== 0)
  )
    throw new Error("Invalid attempt start turn");
  let previousTurn = -1;
  let handoffs = task.handoffs?.length ?? 0;
  for (const [index, attempt] of attempts.entries()) {
    name(attempt.commandId, "retry command id");
    const old = attempt.task;
    if (old?.recoveryVersion !== undefined) positive(old.recoveryVersion, "recoveryVersion");
    if (
      !old ||
      Object.hasOwn(old, "attempts") ||
      old.id !== task.id ||
      (old.attempt ?? 0) !== index ||
      (old.attemptStartTurn ?? 0) !== previousTurn + 1 ||
      !["failed", "cancelled"].includes(old.status) ||
      !Number.isSafeInteger(old.turn ?? 0) ||
      (old.turn ?? 0) < (old.attemptStartTurn ?? 0)
    )
      throw new Error("Invalid previous attempt");
    if (
      typeof attempt.finding !== "string" ||
      !attempt.finding.trim() ||
      Buffer.byteLength(attempt.finding, "utf8") > snapshot.limits.maxOutputBytes ||
      snapshot.commands[attempt.commandId] !== canonical({ type: "retry", taskId: task.id, finding: attempt.finding })
    )
      throw new Error("Attempt has no matching retry finding/receipt");
    if (
      old.input !== task.input ||
      canonical(old.dependsOn) !== canonical(task.dependsOn) ||
      old.parentTaskId !== task.parentTaskId ||
      old.createdByCommand !== task.createdByCommand
    )
      throw new Error("Retry changed task specification or ownership");
    for (const [value, ids] of [
      [old.sessionId, sessions],
      [old.dispatchId, dispatches],
    ] as const) {
      name(value, "previous attempt identity");
      if (ids.has(value)) throw new Error("Duplicate previous attempt identity");
      ids.add(value);
    }
    if (old.output !== undefined) validateOutput(old.output, snapshot.limits.maxOutputBytes);
    validateTaskHandoffs(old, snapshot, sessions, dispatches);
    previousTurn = old.turn ?? 0;
    handoffs += old.handoffs?.length ?? 0;
  }
  if (attempts.length && start !== previousTurn + 1) throw new Error("Retry turn is not the next global task turn");
  if (handoffs > (snapshot.limits.maxHandoffs ?? 4)) throw new Error("Attempts exceed lifetime maxHandoffs");
}

function validateGraphHistory(snapshot: CoordinationSnapshot, sessions: Set<string>, dispatches: Set<string>): void {
  const revisions = snapshot.graphChanges ?? [];
  if (!Array.isArray(revisions) || revisions.length > (snapshot.limits.maxGraphChanges ?? 32))
    throw new Error("Invalid graph rewrite history size");
  const removed = new Set<string>();
  let totalRemoved = 0;
  for (const revision of revisions) {
    name(revision.commandId, "graph rewrite command id");
    const change = revision.change;
    if (
      !change ||
      typeof change !== "object" ||
      Object.keys(change).some((key) => !["add", "update", "remove"].includes(key))
    )
      throw new Error("Invalid graph change");
    for (const values of [change.add, change.update, change.remove, revision.previous])
      if (values !== undefined && !Array.isArray(values)) throw new Error("Invalid graph change operations");
    if (
      !Array.isArray(revision.previous) ||
      snapshot.commands[revision.commandId] !== canonical({ type: "rewrite-graph", change })
    )
      throw new Error("Graph change has no matching receipt");
    const touched = [...(change.update ?? []).map((task: TaskSpec) => task.id), ...(change.remove ?? [])];
    const all = [...touched, ...(change.add ?? []).map((task: TaskSpec) => task.id)];
    if (
      !all.length ||
      all.length > snapshot.limits.maxTasks ||
      new Set(all).size !== all.length ||
      canonical([...touched].sort()) !== canonical(revision.previous.map((task: CoordinationTask) => task.id).sort())
    )
      throw new Error("Invalid graph rewrite identities");
    for (const id of all) {
      name(id, "graph rewrite task id");
      if (removed.has(id)) throw new Error("Removed task id was reused");
    }
    for (const old of revision.previous) {
      if (old.recoveryVersion !== undefined) positive(old.recoveryVersion, "recoveryVersion");
      if (
        old.status !== "queued" ||
        old.parentTaskId !== undefined ||
        old.createdByCommand !== undefined ||
        (old.turn ?? 0) !== 0 ||
        old.inbox !== undefined ||
        old.cancelRequested ||
        old.output ||
        old.waitFor ||
        old.waitForMessages ||
        old.pendingHandoff ||
        old.handoffs?.length ||
        old.attempts?.length
      )
        throw new Error("Graph rewrite discarded submitted history");
      for (const [value, ids] of [
        [old.sessionId, sessions],
        [old.dispatchId, dispatches],
      ] as const) {
        name(value, "previous graph identity");
        if (ids.has(value)) throw new Error("Duplicate previous graph identity");
        ids.add(value);
      }
      name(old.agent, "previous graph agent");
      name(old.agentVersion, "previous graph agent version");
    }
    for (const id of change.remove ?? []) {
      removed.add(id);
      totalRemoved++;
    }
  }
  if (
    snapshot.tasks.some((task) => removed.has(task.id)) ||
    snapshot.tasks.length + totalRemoved > snapshot.limits.maxTasks
  )
    throw new Error("Invalid lifetime task count");
}
