import type { UiClient } from "@sortedyuan/ui-client";

export interface GatewayBrowserState {
  disposed: boolean;
  readonly activeDialogs: Set<HTMLDialogElement>;
  readonly pendingActions: Set<Promise<void>>;
  readonly actionErrors: unknown[];
}

export type GatewayDialogs = ReturnType<typeof createGatewayDialogs>;

export interface GatewayBrowserContext {
  readonly client: UiClient;
  readonly state: GatewayBrowserState;
  readonly dialogs: GatewayDialogs;
  readonly data: (kind: string) => Promise<unknown>;
}

export function createGatewayDialogs(client: UiClient, state: GatewayBrowserState, agents: () => Promise<void>) {
  const { activeDialogs, pendingActions, actionErrors } = state;

  function runAction(action: () => unknown, onError: (reason: unknown) => void = showError): void {
    const task = Promise.resolve()
      .then(action)
      .then(
        () => {},
        (error) => {
          if (state.disposed) actionErrors.push(error);
          else onError(error);
        },
      )
      .catch((error) => {
        actionErrors.push(error);
      })
      .finally(() => {
        pendingActions.delete(task);
      });
    pendingActions.add(task);
  }

  function statusPill(status: string): HTMLElement {
    const span = document.createElement("span");
    span.className = "gateway-status-pill";
    const labels: Record<string, string> = {
      active: "[活动]",
      running: "[运行中]",
      completed: "[已完成]",
      failed: "[失败]",
      cancelled: "[已取消]",
      pending: "[待处理]",
      archived: "[已归档]",
      deleting: "[正在删除]",
      unloaded: "[未加载]",
      unknown: "[未知状态]",
      delivered: "[已送达]",
      disabled: "[已停用]",
    };
    span.textContent = labels[status] ?? `[${status}]`;
    return span;
  }

  function modal(title: string) {
    if (state.disposed) {
      throw new Error("网关管理组件已释放。");
    }
    const previousActive = document.activeElement as HTMLElement | null;
    const dialog = document.createElement("dialog");
    activeDialogs.add(dialog);
    dialog.className = "connect-dialog gateway-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");

    const titleId = "dialog-title-" + Math.random().toString(36).slice(2, 9);
    dialog.setAttribute("aria-labelledby", titleId);

    const form = document.createElement("form");
    form.className = "gateway-dialog-form";
    Object.assign(form.style, {
      maxHeight: "82vh",
      overflowY: "auto",
      overflowX: "hidden",
      width: "100%",
      maxWidth: "min(40rem, calc(100vw - 32px))",
      boxSizing: "border-box",
    });

    const heading = document.createElement("h2");
    heading.id = titleId;
    heading.textContent = title;

    const error = document.createElement("p");
    error.className = "dialog-error";
    error.setAttribute("role", "alert");

    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    actions.append(button("关闭", () => dialog.close()));

    form.append(heading, error, actions);
    dialog.append(form);
    document.body.append(dialog);

    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dialog.close();
      }
    });

    dialog.addEventListener(
      "close",
      () => {
        activeDialogs.delete(dialog);
        dialog.remove();
        if (previousActive && previousActive.isConnected) {
          previousActive.focus();
        }
      },
      { once: true },
    );

    dialog.showModal();
    return {
      form,
      actions,
      dialog,
      insert: (node: Node) => form.insertBefore(node, error),
      fail: (reason: unknown) => {
        error.textContent = reason instanceof Error ? reason.message : String(reason);
      },
    };
  }

  function showError(reason: unknown) {
    if (state.disposed) return;
    const view = modal("操作未完成");
    view.fail(reason);
  }

  function button(label: string, action: () => unknown, className = "button") {
    const control = document.createElement("button");
    control.type = "button";
    control.className = className;
    control.textContent = label;
    control.addEventListener("click", () => {
      runAction(action);
    });
    return control;
  }

  function field(view: ReturnType<typeof modal>, label: string, value = "", multiline = false) {
    const wrapper = document.createElement("label");
    wrapper.className = "field-label";
    wrapper.textContent = label;
    const input = multiline ? document.createElement("textarea") : document.createElement("input");
    input.value = value;
    input.className = "token-input";
    input.setAttribute("aria-label", label);
    if (input instanceof HTMLTextAreaElement) input.rows = 5;
    wrapper.append(input);
    view.insert(wrapper);
    return input;
  }

  function choice(view: ReturnType<typeof modal>, label: string, values: readonly [string, string][]) {
    const wrapper = document.createElement("label");
    wrapper.className = "field-label";
    wrapper.textContent = label;
    const select = document.createElement("select");
    select.setAttribute("aria-label", label);
    for (const [val, text] of values) {
      const option = document.createElement("option");
      option.value = val;
      option.textContent = text;
      select.append(option);
    }
    wrapper.append(select);
    view.insert(wrapper);
    return select;
  }

  function note(view: ReturnType<typeof modal>, text: string) {
    const paragraph = document.createElement("p");
    paragraph.className = "detail-note";
    paragraph.textContent = text;
    view.insert(paragraph);
  }

  function submit(view: ReturnType<typeof modal>, label: string, action: () => Promise<void>) {
    const control = document.createElement("button");
    control.type = "submit";
    control.textContent = label;
    control.className = "button primary";
    view.actions.append(control);
    view.form.onsubmit = (event) => {
      event.preventDefault();
      control.disabled = true;
      runAction(
        async () => {
          await action();
          view.dialog.close();
        },
        (reason) => {
          control.disabled = false;
          view.fail(reason);
        },
      );
    };
  }

  function collapsibleJson(view: ReturnType<typeof modal>, summaryText: string, dataValue: unknown) {
    const details = document.createElement("details");
    details.className = "gateway-diag";
    const summary = document.createElement("summary");
    summary.textContent = summaryText;
    const pre = document.createElement("pre");
    pre.className = "tool-content";
    pre.textContent = JSON.stringify(dataValue, null, 2);
    details.append(summary, pre);
    view.insert(details);
  }

  function entryFields(view: ReturnType<typeof modal>) {
    const kind = choice(view, "聊天入口", [
      ["", "仅通过控制端使用"],
      ["private", "平台私聊"],
      ["group", "平台群聊或话题"],
    ]);
    const account = field(view, "平台账户 ID，例如 telegram:123456");
    const conversation = field(view, "聊天 ID");
    const owner = field(view, "私聊用户 ID");
    const threadId = field(view, "话题 ID（可选）");
    return () =>
      kind.value
        ? {
            kind: kind.value,
            account: account.value.trim(),
            conversation: conversation.value.trim(),
            ...(kind.value === "private" ? { owner: owner.value.trim() } : {}),
            ...(threadId.value.trim() ? { threadId: threadId.value.trim() } : {}),
          }
        : undefined;
  }

  function agentChoices(view: ReturnType<typeof modal>, label: string, selected: readonly string[] = []) {
    const group = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = label;
    group.append(legend);
    const controls: HTMLInputElement[] = [];
    const fields = client.state.snapshot?.panels.find((panel) => panel.id === "agents")?.fields ?? [];
    if (!fields.length) {
      const tip = document.createElement("p");
      tip.textContent = "当前尚未配置 Agent。";
      const add = button("添加 Agent", () => {
        view.dialog.close();
        return agents();
      });
      group.append(tip, add);
    }
    for (const agent of fields) {
      const wrapper = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = agent.label;
      input.checked = selected.includes(agent.label);
      controls.push(input);
      wrapper.append(input, document.createTextNode(` ${agent.label} · ${agent.value}`));
      group.append(wrapper, document.createElement("br"));
    }
    view.insert(group);
    return () => controls.filter((input) => input.checked).map((input) => input.value);
  }

  return { statusPill, modal, button, field, choice, note, submit, collapsibleJson, entryFields, agentChoices };
}
