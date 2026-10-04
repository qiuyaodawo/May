import type { UiAction, UiClient, UiClientState, UiCompletion, UiForm } from "@may/ui-client";
import { button, element } from "./components.js";

export function createCommandUI(client: UiClient, composer: HTMLTextAreaElement, local: (command: string) => boolean) {
  const root = element("section", "command-workbench"); root.setAttribute("aria-label", "命令与交互");
  const output = element("section", "command-output"); output.hidden = true;
  const forms = element("section", "command-forms");
  const suggestions = element("div", "command-suggestions"); suggestions.hidden = true; suggestions.id = "command-suggestions"; suggestions.setAttribute("role", "listbox"); suggestions.setAttribute("aria-label", "命令补全");
  composer.setAttribute("aria-controls", suggestions.id);
  root.append(output, forms);
  let state = client.state, signature = "", request = 0, index = 0, items: readonly UiCompletion[] = [], disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const panels = new Map<string, HTMLElement>();
  const dialogs = new Set<HTMLDialogElement>();
  const error = (parent: HTMLElement, reason: unknown) => { const text = element("p", "dialog-error", reason instanceof Error ? reason.message : "操作失败。"); text.setAttribute("role", "alert"); parent.append(text); };
  function clearSuggestions() { request++; items = []; suggestions.replaceChildren(); suggestions.hidden = true; composer.removeAttribute("aria-activedescendant"); }
  function choose(value: string) { composer.value = value; clearSuggestions(); composer.dispatchEvent(new Event("input")); composer.focus(); }
  function renderSuggestions() {
    suggestions.replaceChildren(); suggestions.hidden = !items.length;
    for (const [position, item] of items.entries()) {
      const option = button(`${item.label}${item.description ? " · " + item.description : ""}`, () => choose(item.value), "command-suggestion");
      option.id = `command-option-${position}`; option.setAttribute("role", "option"); option.setAttribute("aria-selected", String(index === position)); suggestions.append(option);
    }
    if (items.length) composer.setAttribute("aria-activedescendant", `command-option-${index}`);
  }
  function input() {
    clearTimeout(timer); clearSuggestions();
    const text = composer.value.trimStart();
    if (!state.snapshot?.controls || state.connection !== "connected" || !text.startsWith("/") || text.length > 1024) return;
    const id = request;
    timer = setTimeout(() => {
      void client.complete(text).then(result => {
        if (disposed || id !== request || text !== composer.value.trimStart()) return;
        const display = ["/details", "/thinking"].filter(value => value.startsWith(text)).map(value => ({ value, label: value, description: "页面显示设置" }));
        items = [...result.items, ...display]; index = 0; renderSuggestions();
      }).catch(reason => { if (!disposed && id === request) { clearSuggestions(); error(suggestions, reason); suggestions.hidden = false; } });
    }, 100);
  }
  function key(event: KeyboardEvent) {
    if (!items.length || event.isComposing) return;
    if (event.key === "Escape") { clearSuggestions(); event.preventDefault(); event.stopImmediatePropagation(); }
    else if (["ArrowDown", "ArrowUp", "Tab"].includes(event.key)) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key === "Tab") choose(items[index]!.value);
      else { index = (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; renderSuggestions(); }
    }
  }
  composer.addEventListener("input", input); composer.addEventListener("keydown", key);

  function perform(action: UiAction) {
    const target = state.snapshot?.selectedId, host = state.snapshot?.hostId;
    const execute = async (args: Record<string, string>) => {
      if (target !== client.state.snapshot?.selectedId || host !== client.state.snapshot?.hostId) throw new Error("会话已改变，请重新选择操作。");
      await client.command(action.command, args, target);
    };
    if (!action.confirm && !action.input) { void execute({ ...action.args }).catch(reason => error(output, reason)); return; }
    const dialog = element("dialog", "connect-dialog"), form = element("form");
    const headingId = "command-action-title-" + Math.random().toString(36).slice(2, 9);
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", headingId);
    const heading = element("h2", "", action.label);
    heading.id = headingId;
    form.append(heading);
    if (action.confirm) form.append(element("p", "", action.confirm));
    const field = element("input", "token-input");
    if (action.input) { field.value = action.input.value; field.required = true; field.maxLength = 160; field.setAttribute("aria-label", action.input.label); form.append(field); }
    const submit = element("button", "button primary", "确认"); submit.type = "submit";
    form.append(button("取消", () => dialog.close()), submit);
    form.onsubmit = event => { event.preventDefault(); submit.disabled = true;
      void execute({ ...action.args, ...(action.input ? { [action.input.name]: field.value } : {}) }).then(() => dialog.close(), reason => { submit.disabled = false; error(form, reason); });
    };
    dialog.append(form); dialogs.add(dialog); document.body.append(dialog);
    dialog.onclose = () => { dialogs.delete(dialog); dialog.remove(); }; dialog.showModal();
  }

  function interaction(item: UiForm): HTMLElement {
    const panel = element("section", "command-form"); panel.setAttribute("aria-label", item.title);
    panel.append(element("h3", "", item.title), element("pre", "tool-content", item.detail));
    const evidence = element("pre", "tool-content", item.value); panel.append(evidence);
    const editor = element("textarea", "command-json"); editor.rows = 8; editor.maxLength = 64 * 1024; editor.setAttribute("aria-label", "MCP JSON 内容");
    editor.value = item.mode === "review" ? item.value : "{}";
    if (item.editable) panel.append(editor);
    if (item.mode === "form") panel.append(element("p", "", "按照上面的 JSON Schema 输入表单内容。请勿填写密码、API key 或支付凭据。"));
    const preview = element("pre", "tool-content"); preview.hidden = true; panel.append(preview);
    const actions = element("div", "command-actions"); panel.append(actions);
    const send = async (action: string, content?: unknown) => {
      const controls = client.state.snapshot?.controls;
      if (!controls?.forms.some(form => form.id === item.id)) throw new Error("交互已经结束。");
      await client.interact(controls.responseCommand, { id: item.id, action, ...(content === undefined ? {} : { content: JSON.stringify(content) }) });
    };
    const respond = (action: string, content?: unknown) => {
      for (const control of actions.querySelectorAll("button")) control.disabled = true;
      void send(action, content).catch(reason => { for (const control of actions.querySelectorAll("button")) control.disabled = false; error(panel, reason); });
    };
    actions.append(button("拒绝", () => respond("decline")), button("取消", () => respond("cancel")));
    if (item.mode === "url") {
      const url = new URL(item.url!);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("MCP URL 无效。");
      panel.append(element("p", "", `外部网站：${url.host}\n${url.href}`));
      const consent = button("同意访问此网站", () => {
        consent.remove();
        const link = element("a", "button", "打开外部网站"); link.href = url.href; link.target = "_blank"; link.rel = "noreferrer noopener"; actions.append(link);
        actions.append(button("已完成网站操作，重试请求", () => respond("accept")));
      }); actions.append(consent);
    } else {
      let reviewed: string | undefined;
      const accept = button("确认发送", () => {
        if (reviewed !== editor.value) { error(panel, new Error("内容已改变，请重新预览。")); return; }
        const content: unknown = JSON.parse(editor.value);
        respond("accept", item.mode === "review" ? item.editable ? { json: JSON.stringify(content) } : undefined : content);
      }); accept.disabled = true;
      actions.append(button("预览提交内容", () => {
        try {
          const content: unknown = JSON.parse(editor.value);
          if (item.mode === "form" && (!content || typeof content !== "object" || Array.isArray(content))) throw new Error("表单内容必须为 JSON 对象。");
          reviewed = editor.value; preview.textContent = JSON.stringify(content, null, 2); preview.hidden = false; accept.disabled = false;
        } catch (reason) { accept.disabled = true; error(panel, reason); }
      }), accept);
      editor.oninput = () => { accept.disabled = true; reviewed = undefined; };
    }
    return panel;
  }

  return { root, suggestions, perform,
    async submit(text: string): Promise<boolean> {
      if (!state.snapshot?.controls || !text.trimStart().startsWith("/")) return false;
      clearSuggestions();
      if (local(text.trim())) return true;
      if (["/quit", "/exit"].includes(text.trim())) {
        perform({ label: "退出 MaybeCode", confirm: "确认关闭当前 MaybeCode 宿主及其 Web 服务？", command: state.snapshot.controls.inputCommand, args: { text } }); return true;
      }
      await client.command(state.snapshot.controls.inputCommand, { text }); return true;
    },
    update(next: UiClientState) {
      const outputChanged = next.output !== state.output;
      if (next.snapshot?.selectedId !== state.snapshot?.selectedId || next.snapshot?.hostId !== state.snapshot?.hostId) {
        clearSuggestions(); for (const dialog of dialogs) dialog.close();
      }
      state = next;
      const nextSignature = JSON.stringify([state.output, state.busy, state.snapshot?.controls?.busy, state.snapshot?.commands]);
      if (signature !== nextSignature) {
        signature = nextSignature; output.replaceChildren(); output.hidden = !state.output;
        if (state.output) {
          output.append(element("h3", "", state.output.title), element("pre", "tool-content", state.output.text));
          const actions = element("div", "command-actions");
          for (const action of state.output.actions ?? []) { const control = button(action.label, () => perform(action)); control.disabled = state.busy || !state.snapshot?.commands.includes(action.command); actions.append(control); }
          output.append(actions);
        }
      }
      const pending = state.snapshot?.controls?.forms ?? [];
      for (const [id, panel] of panels) if (!pending.some(item => item.id === id)) { panel.remove(); panels.delete(id); }
      for (const item of pending) if (!panels.has(item.id)) { const panel = interaction(item); panels.set(item.id, panel); forms.append(panel); }
      root.hidden = output.hidden && !pending.length;
      if (outputChanged && state.output) root.scrollIntoView({ block: "nearest" });
    },
    dispose() { disposed = true; clearTimeout(timer); clearSuggestions(); composer.removeEventListener("input", input); composer.removeEventListener("keydown", key); for (const dialog of dialogs) dialog.close(); panels.clear(); root.remove(); suggestions.remove(); },
  };
}
