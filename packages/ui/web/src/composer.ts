import type { UiClient, UiClientState } from "@sortedyuan/ui-client";
import { button, element, icon } from "./components.js";
import type { createUiTasks } from "./tasks.js";

export function createComposer(
  client: UiClient,
  tasks: ReturnType<typeof createUiTasks>,
  host: {
    readonly getState: () => UiClientState;
    readonly pending: () => boolean;
    readonly has: (name: string) => boolean;
    readonly act: (name: string, args?: Record<string, string>) => void;
    readonly submit: (text: string) => Promise<boolean>;
  },
) {
  const { pending, has, act } = host;
  const composerArea = element("div", "composer-area");
  const form = element("form", "composer");
  const composer = element("textarea");
  composer.rows = 2;
  composer.maxLength = 16_384;
  composer.placeholder = "描述你想完成的事…";
  composer.setAttribute("aria-label", "消息输入");
  const toolbar = element("div", "composer-toolbar");
  const choices = element("div", "composer-choices");
  const send = element("button", "send-button");
  send.type = "submit";
  send.append(icon("send"));
  send.setAttribute("aria-label", "发送消息");
  const cancel = button(
    "",
    () => {
      const state = host.getState();
      const controls = state.snapshot?.controls;
      if (controls) tasks.run(client.interact(controls.cancelCommand));
      else act(state.snapshot?.product.resourceKind === "task" ? "task.cancel" : "run.cancel");
    },
    "send-button stop-button",
  );
  cancel.append(icon("stop"));
  cancel.setAttribute("aria-label", "取消当前运行");
  cancel.hidden = true;
  toolbar.append(choices, cancel, send);
  form.append(composer, toolbar);
  const composerHint = element("div", "composer-hint", "Enter 发送 · Shift + Enter 换行");
  composerArea.append(form, composerHint);

  let draftKey = "new",
    selected: string | null = null;
  const drafts = new Map<string, string>();
  let choiceSignature = "";
  function updateComposer(): void {
    const state = host.getState();
    const text = composer.value.trim();
    const controls = state.snapshot?.controls;
    const canSubmit =
      controls && text.startsWith("/")
        ? has(controls.inputCommand)
        : state.snapshot?.product.resourceKind === "task"
          ? has("task.submit") && !selected
          : has("message.submit");
    send.hidden = !cancel.hidden && (!text || !canSubmit);
    send.disabled = !text || pending() || state.connection !== "connected" || !canSubmit;
    composer.rows = Math.min(8, Math.max(2, composer.value.split("\n").length));
  }
  composer.oninput = () => {
    drafts.set(draftKey, composer.value);
    updateComposer();
  };
  composer.onkeydown = (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!send.disabled && !send.hidden) form.requestSubmit();
    }
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    if (send.disabled) return;
    const text = composer.value,
      key = draftKey;
    tasks.run(
      host
        .submit(text)
        .then((handled) =>
          handled
            ? undefined
            : client.command(
                host.getState().snapshot?.product.resourceKind === "task" ? "task.submit" : "message.submit",
                {
                  text,
                },
              ),
        )
        .then(() => {
          drafts.delete(key);
          if (draftKey === key && composer.value === text) composer.value = "";
          updateComposer();
        }),
    );
  };

  return {
    area: composerArea,
    form,
    textarea: composer,
    select(nextSelected: string | null): void {
      const changedSelection = selected !== nextSelected;
      if (changedSelection) {
        drafts.set(draftKey, composer.value);
        selected = nextSelected;
        draftKey = selected ?? "new";
        composer.value = drafts.get(draftKey) ?? "";
      }
    },
    selected: (): string | null => selected,
    fill(text: string): void {
      composer.value = text;
      composer.focus();
      drafts.set(draftKey, text);
      updateComposer();
    },
    forget(id: string): void {
      drafts.delete(id);
    },
    update(isTask: boolean, connected: boolean): void {
      const state = host.getState();
      const snapshot = state.snapshot;
      composer.placeholder =
        isTask && selected
          ? "当前任务已提交；新建任务以开始另一项工作"
          : isTask
            ? "描述任务、预期结果与约束…"
            : "描述需求、提问，或一起解决一个问题…";
      composer.disabled = Boolean(isTask && selected);
      const choicesKey = JSON.stringify([snapshot?.choices, pending(), snapshot?.commands, state.connection]);
      if (choicesKey !== choiceSignature) {
        choiceSignature = choicesKey;
        choices.replaceChildren();
        for (const choice of snapshot?.choices ?? []) {
          const select = element("select", "model-select");
          select.setAttribute("aria-label", choice.label);
          for (const item of choice.options) {
            const option = element("option", "", item.label);
            option.value = item.value;
            select.append(option);
          }
          select.value = choice.value;
          select.disabled = !connected || pending() || !has(choice.command);
          select.onchange = () => act(choice.command, { value: select.value });
          choices.append(select);
        }
        if (!snapshot?.choices.length)
          choices.append(element("span", "composer-mode", isTask ? "持久任务" : "本地 Agent"));
      }
      const controls = snapshot?.controls;
      cancel.hidden = controls
        ? !(state.busy || controls.busy) || !has(controls.cancelCommand)
        : !has(isTask ? "task.cancel" : "run.cancel");
      cancel.disabled = !connected || (controls ? state.selecting : pending());
      updateComposer();
      composerHint.textContent = !connected
        ? "需要连接本地服务 · 不会自动发送输入"
        : isTask && selected
          ? "关闭页面不会中止任务 · 执行、验证与送达分别记录"
          : "Enter 发送 · Shift + Enter 换行 · 请核对 Agent 的输出";
    },
  };
}
