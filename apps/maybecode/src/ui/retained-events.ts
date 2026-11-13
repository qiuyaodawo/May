import type { TerminalImages } from "@sortedyuan/tui";
import type { TranscriptStore } from "@sortedyuan/tui/transcript";
import { codingChangePresentation } from "@sortedyuan/tui/tool-renderers";
import type { ApprovalRequest } from "@sortedyuan/may/permissions";
import { userInfo } from "node:os";
import type { MaybeCodeController } from "../controller.js";
import type { MaybeCodeTerminalView } from "./terminal-view.js";
import type { MaybeCodeEvent } from "../events.js";
import { presentMcpInteraction } from "../mcp-interaction-ui.js";
import { formatGoal } from "../goal-commands.js";
import { delegationOrder, formatDelegationTree, renderDelegationTask } from "../delegation-commands.js";
import { errorMessage, isCancellation, refreshModelLabel } from "./retained-labels.js";

export async function consumeEvents(
  app: MaybeCodeController,
  store: TranscriptStore,
  view: MaybeCodeTerminalView,
  isClosing: () => boolean,
  events: AsyncIterable<MaybeCodeEvent>,
  images: TerminalImages,
  displayedSteering: Set<string>,
  onStopped: () => void,
): Promise<void> {
  const approvals = new Set<Promise<void>>();
  const approvalErrors: unknown[] = [];
  const trackApproval = (operation: Promise<void>, finish?: () => void): void => {
    const task = operation
      .catch((error) => {
        approvalErrors.push(error);
        onStopped();
      })
      .finally(() => {
        finish?.();
        approvals.delete(task);
      });
    approvals.add(task);
  };
  const interactions = new Map<string, AbortController>();
  const delegationStatus = new Map<string, string>();
  let lastGoalDisplay = "";
  try {
    for await (const event of events) {
      if (event.type === "run.event") {
        if (event.event.type === "run.started") {
          view.setStatus("Running");
          const unread = app.application.agent
            .listSteeringInputs()
            .filter((input) => input.status === "delivered" && !displayedSteering.has(input.inputId));
          if (unread.length > 0) {
            const history = await app.history();
            const runId = event.event.runId;
            const runIndex = history.findIndex((item) => item.type === "run.started" && item.runId === runId);
            const submitted =
              runIndex < 0
                ? undefined
                : history
                    .slice(0, runIndex)
                    .reverse()
                    .find((item) => item.type === "input.submitted");
            if (
              submitted?.type === "input.submitted" &&
              submitted.inputId &&
              unread.some((input) => input.inputId === submitted.inputId)
            ) {
              store.appendUser(
                submitted.message.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join(""),
              );
              displayedSteering.add(submitted.inputId);
            }
          }
        }
        if (event.event.type === "input.received") {
          for (const input of app.application.agent.listSteeringInputs()) {
            if (input.status === "delivered" && input.runId === event.event.runId) displayedSteering.add(input.inputId);
          }
        }
        // 主 Run 让出时子任务还在运行，状态不能显示为 Ready。
        if (
          event.event.type === "run.completed" ||
          event.event.type === "run.yielded" ||
          event.event.type === "run.cancelled"
        ) {
          view.setStatus(app.isRunning ? "Delegating" : "Ready");
        }
        if (event.event.type === "run.failed") view.setStatus(`Error: ${event.event.error.message}`);
      }
      if (event.type === "permission-mode.changed") {
        view.setStatus(event.mode === "yolo" ? "YOLO enabled" : "YOLO disabled");
      }
      if (event.type === "run.event" && event.event.type === "model.completed")
        await images.prepare(event.event.message.content);
      if (event.type === "run.event" && event.event.type === "tool.completed")
        await images.prepare(event.event.content);
      if (event.type === "goal.changed") {
        view.setStatus(`Goal ${event.goal.status}`);
        const display = `${event.goal.id}:${event.goal.status}:${event.goal.progress}`;
        if (display !== lastGoalDisplay) {
          lastGoalDisplay = display;
          store.appendNotice("info", formatGoal(event.goal));
        }
      }
      if (event.type === "delegation.started" || event.type === "delegation.finished") {
        if (event.type === "delegation.started") delegationStatus.clear();
        const label = event.type === "delegation.started" ? "Sub-agent request" : "Sub-agent request finished";
        if (app.delegationNotifications === true)
          store.appendNotice("info", `${label}\n${formatDelegationTree(event.state)}`);
        view.setStatus(event.type === "delegation.started" ? "Delegating" : "Ready");
      } else if (event.type === "delegation.updated") {
        // 同一任务的重复状态不显示。
        for (const task of delegationOrder(event.state.tasks)) {
          const previous = delegationStatus.get(task.id);
          delegationStatus.set(task.id, task.status);
          if (app.delegationNotifications !== true || previous === task.status) continue;
          store.appendNotice(
            ["failed", "cancelled", "recovery-required"].includes(task.status) ? "warning" : "info",
            renderDelegationTask(task),
          );
        }
      }
      applyMaybeCodeEvent(store, event);
      if (event.type === "mcp.interaction.requested") {
        const controller = new AbortController();
        interactions.set(event.request.id, controller);
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(Math.max(0, Math.ceil(event.request.expiresAt - Date.now()))),
        ]);
        trackApproval(
          presentMcpInteraction(
            event.request,
            app,
            (prompt, signal) => view.requestMcpInput(prompt, signal),
            signal,
          ).catch(() => {
            if (!isClosing() && !signal.aborted) {
              store.appendNotice("warning", "MCP interaction could not be completed");
              app.cancel("User interaction is unavailable");
            }
          }),
          () => {
            interactions.delete(event.request.id);
          },
        );
      } else if (event.type === "mcp.interaction.settled") interactions.get(event.requestId)?.abort();
      if (event.type === "model.changed") {
        await refreshModelLabel(view, app);
      }
      if (event.type === "session.changed" && event.resumed) {
        const history = await app.history();
        for (const event of history)
          if (event.type === "assistant.completed" || event.type === "input.submitted")
            await images.prepare(event.message.content);
        for (const event of history)
          if (event.type === "tool.completed" && event.content) await images.prepare(event.content);
        store.loadHistory(history);
        displayedSteering.clear();
        for (const event of history) {
          if (event.type === "input.submitted" && event.inputId) displayedSteering.add(event.inputId);
          if (event.type === "input.steering.delivered")
            for (const inputId of event.inputIds) displayedSteering.add(inputId);
        }
        store.appendNotice("info", "Session resumed");
        continue;
      }
      if (event.type === "permission.event" && event.event.type === "approval.requested") {
        trackApproval(presentApproval(app, view, store, event.event.request, isClosing));
      } else if (
        event.type === "permission.event" &&
        (event.event.type === "approval.resolved" || event.event.type === "approval.cancelled")
      ) {
        view.dismissApproval(event.event.requestId);
      }
      if (event.type === "delegation.event" && event.event.type === "permission.event") {
        // 子任务审批：包在外层事件里，同样需要界面与路由。
        const inner = event.event.event;
        if (inner.type === "approval.requested") {
          store.appendNotice("info", `子任务 ${event.taskId} 请求批准 ${inner.request.tool.name}`);
          trackApproval(presentApproval(app, view, store, inner.request, isClosing));
        } else if (inner.type === "approval.resolved" || inner.type === "approval.cancelled") {
          view.dismissApproval(inner.requestId);
        }
      }
    }
  } finally {
    onStopped();
    for (const controller of interactions.values()) controller.abort();
    await Promise.all(approvals);
    if (approvalErrors.length) throw new AggregateError(approvalErrors, "MaybeCode approval operations failed");
  }
}

/** 打开审批对话框并把决定交回宿主，由宿主路由到提出请求的 Session。 */
function presentApproval(
  app: MaybeCodeController,
  view: MaybeCodeTerminalView,
  store: TranscriptStore,
  request: ApprovalRequest,
  isClosing: () => boolean,
): Promise<void> {
  return view
    .requestApproval(request)
    .then(async (decision) => {
      if (decision !== undefined && !isClosing()) {
        await app.resolveApproval(
          request.id,
          decision,
          decision === "allow-persistent" ? { createdBy: `local:${userInfo().username}` } : undefined,
        );
      }
    })
    .catch((error: unknown) => {
      if (!isClosing()) {
        store.appendNotice("error", `Approval failed: ${errorMessage(error)}`);
      } else if (!isCancellation(error)) {
        throw error;
      }
    });
}

function applyMaybeCodeEvent(store: TranscriptStore, event: MaybeCodeEvent): void {
  switch (event.type) {
    case "delegation.finished":
    case "delegation.started":
    case "delegation.updated":
    case "goal.changed":
    case "mcp.interaction.requested":
    case "mcp.interaction.settled":
    case "permission-mode.changed":
    case "session.forked":
    case "workspace.git.changed":
      break;
    case "run.event":
      store.applyMayEvent(event.event);
      break;
    case "delegation.event":
      // 子 Agent 的 Run 与审批事件进入同一个记录流，Run 身份彼此独立。
      if (event.event.type === "run.event") store.applyMayEvent(event.event.event);
      else if (event.event.type === "permission.event") store.applyPermissionEvent(event.event.event);
      break;
    case "permission.event":
      store.applyPermissionEvent(event.event);
      break;
    case "change.preview":
      store.attachToolPresentation(event.runId, event.step, event.toolCallId, codingChangePresentation(event.preview));
      break;
    case "tool.presentation":
      store.appendToolPresentation(event.presentation);
      break;
    case "session.changed":
      store.reset(event.sessionId);
      store.appendNotice("info", `Session ${event.resumed ? "resumed" : "started"}: ${event.sessionId}`);
      break;
    case "model.changed": {
      const profile = event.model.profile === undefined ? "" : ` profile ${event.model.profile}`;
      store.appendNotice("info", `Model switched to${profile}: ${event.model.provider}/${event.model.model}`);
      break;
    }
    case "model.default.changed":
      store.appendNotice("info", `Default model set to ${event.profile}`);
      break;
    case "mcp.resource.updated":
      store.appendNotice("info", `MCP resource updated: ${event.serverId} ${event.uri}`);
      break;
    case "mcp.resource.watch-closed":
      store.appendNotice("info", `MCP resource watch closed: ${event.serverId} ${event.uri} (${event.reason})`);
      break;
    case "mcp.server.connected":
      store.appendNotice("info", `MCP server connected: ${event.serverId} ` + `(${event.toolNames.length} tools)`);
      break;
    case "mcp.server.catalog-updated":
      store.appendNotice("info", `MCP catalog updated: ${event.serverId} (revision ${event.revision})`);
      break;
    case "mcp.server.failed":
      store.appendNotice("warning", `MCP server failed: ${event.serverId}: ${event.diagnostic.message}`);
      break;
    case "mcp.server.disconnected":
      store.appendNotice("info", `MCP server disconnected: ${event.serverId}`);
      break;
    case "context.compacted":
      store.appendNotice(
        "info",
        `Context compacted with ${event.strategy}: ` +
          `${event.before.messageCount} → ${event.after.messageCount} messages`,
      );
      break;
    case "context.compaction.failed":
      store.appendNotice("warning", `Context compaction failed with ${event.strategy}: ${event.error.message}`);
      break;
  }
}
