/**
 * 手机与网页上的助手控制面板。由 /assistant-panel.js 直接加载，
 * 只使用浏览器 API，不引用 Node 侧模块。
 */

interface PanelState {
  readonly connection: string;
  readonly busy: boolean;
  readonly snapshot: {
    readonly commands: readonly string[];
    readonly panels: readonly { id: string; fields: readonly { label: string; value: string }[] }[];
  } | undefined;
}

interface PanelContext {
  command(name: string, args: Record<string, string>): Promise<{ output?: { text?: string } }>;
}

interface DraftView {
  readonly id: string;
  readonly subject: string;
  readonly to: readonly string[];
  readonly body: string;
  readonly digest: string;
  readonly confirmed: boolean;
}

interface FormView {
  readonly serviceId: string;
  readonly digest: string;
  readonly shortDigest: string;
  readonly submitLabel: string;
  readonly fields: readonly { label: string; value: string; required: boolean; filledByAssistant: boolean }[];
}

const REFRESH_INTERVAL = 20_000;

export function createAssistantPanel(context: PanelContext): {
  readonly element: HTMLElement;
  update(state: PanelState): void;
} {
  const root = document.createElement("section");
  root.className = "assistant-panel";
  root.setAttribute("aria-label", "助手控制");

  const status = document.createElement("p");
  status.className = "assistant-status";
  status.setAttribute("role", "status");
  const actions = document.createElement("div");
  actions.className = "assistant-actions";
  const checkButton = action("检查邮箱", async () => {
    await run("mailbox.check");
    await refreshDrafts();
  });
  const indexButton = action("重新索引资料", async () => {
    await run("vault.reindex");
  });
  actions.append(checkButton, indexButton);

  const draftSection = section("邮件草稿");
  const draftList = document.createElement("div");
  draftList.className = "assistant-drafts";
  draftSection.append(draftList);

  const formSection = section("办事表单");
  const formBody = document.createElement("div");
  formBody.className = "assistant-form";
  formSection.append(
    action("查看当前表单", async () => {
      const outcome = await run("ehall.review");
      renderForm(outcome);
    }),
    formBody,
  );

  const message = document.createElement("p");
  message.className = "assistant-message";
  message.setAttribute("role", "status");

  root.append(status, actions, draftSection, formSection, message);
  appendStyles();

  let lastConnection = "";
  let refresh: ReturnType<typeof setInterval> | undefined;

  async function refreshDrafts(): Promise<void> {
    if (context === undefined) return;
    try {
      const outcome = await run("draft.list");
      const drafts = (outcome.data as { drafts?: DraftView[] } | undefined)?.drafts ?? [];
      renderDrafts(drafts);
    } catch (error) {
      show(error);
    }
  }

  function renderDrafts(drafts: readonly DraftView[]): void {
    draftList.replaceChildren();
    if (drafts.length === 0) {
      draftList.append(line("没有待发送的草稿。"));
      return;
    }
    for (const draft of drafts) {
      const card = document.createElement("article");
      card.className = "assistant-card";
      const heading = document.createElement("strong");
      heading.textContent = draft.subject;
      const meta = document.createElement("p");
      meta.className = "assistant-meta";
      meta.textContent = `${draft.to.join("、")} · 摘要 ${draft.digest} · ${draft.confirmed ? "已确认这一版" : "尚未确认"}`;
      const editor = document.createElement("textarea");
      editor.className = "assistant-editor";
      editor.rows = 6;
      editor.value = draft.body;
      editor.setAttribute("aria-label", `草稿正文：${draft.subject}`);
      const row = document.createElement("div");
      row.className = "assistant-actions";
      row.append(
        action("保存修改", async () => {
          await run("draft.update", { id: draft.id, body: editor.value });
          await refreshDrafts();
        }),
        action("确认这一版", async () => {
          await run("draft.confirm", { id: draft.id });
          await refreshDrafts();
        }, draft.confirmed),
      );
      card.append(heading, meta, editor, row);
      draftList.append(card);
    }
  }

  function renderForm(outcome: { data: unknown }): void {
    const form = outcome.data as FormView | undefined;
    formBody.replaceChildren();
    if (form === undefined || form.fields === undefined) {
      formBody.append(line("当前没有打开的办事页面。"));
      return;
    }
    const table = document.createElement("table");
    table.className = "assistant-table";
    for (const field of form.fields) {
      const row = document.createElement("tr");
      const name = document.createElement("td");
      name.textContent = field.label + (field.required ? " *" : "");
      const value = document.createElement("td");
      value.textContent = field.value === "" ? "（空）" : field.value;
      row.append(name, value);
      table.append(row);
    }
    formBody.append(
      line(`字段摘要 ${form.shortDigest}，提交按钮「${form.submitLabel}」`),
      table,
      action("确认这一版表单", async () => {
        await run("ehall.confirm", { digest: form.digest });
        message.textContent = "表单已确认，助手现在可以提交这一版。";
      }),
    );
  }

  async function run(name: string, args: Record<string, string> = {}): Promise<{ data: unknown }> {
    const receipt = await context.command(name, args);
    const text = receipt.output?.text;
    if (text === undefined) return { data: null };
    const parsed = JSON.parse(text) as { message?: string; data?: unknown };
    message.textContent = parsed.message ?? "";
    return { data: parsed.data ?? null };
  }

  function show(error: unknown): void {
    message.textContent = error instanceof Error ? error.message : String(error);
  }

  return {
    element: root,
    update(state) {
      const fields = state.snapshot?.panels.find((panel) => panel.id === "assistant")?.fields ?? [];
      status.textContent = fields.map((field) => `${field.label}：${field.value}`).join("\n");
      const ready = state.connection === "connected";
      for (const button of [checkButton, indexButton]) button.disabled = !ready;
      if (ready && state.connection !== lastConnection) {
        lastConnection = state.connection;
        void refreshDrafts();
        refresh = setInterval(() => { void refreshDrafts(); }, REFRESH_INTERVAL);
      }
      if (!ready && lastConnection !== "") {
        lastConnection = "";
        if (refresh !== undefined) clearInterval(refresh);
        refresh = undefined;
      }
    },
  };
}

function section(title: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "sidebar-nav-group";
  const heading = document.createElement("div");
  heading.className = "sidebar-label nav-group-title";
  heading.textContent = title;
  element.append(heading);
  return element;
}

function action(label: string, run: () => Promise<void>, disabled = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "sidebar-nav-item";
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", () => {
    button.disabled = true;
    void run().catch(() => undefined).finally(() => { button.disabled = false; });
  });
  return button;
}

function line(text: string): HTMLElement {
  const element = document.createElement("p");
  element.className = "assistant-meta";
  element.textContent = text;
  return element;
}

let stylesAdded = false;

function appendStyles(): void {
  if (stylesAdded) return;
  stylesAdded = true;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/assistant.css";
  document.head.append(link);
}
