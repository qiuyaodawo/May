import type { UiClient } from "@may/ui-client";
import type { WebUiNavigation } from "@may/web-ui";
import type { GatewaySettings, GatewayTask } from "./gateway-types.js";

export function gatewayAuthentication() {
  let token: string | undefined;
  return {
    label: "管理员密码",
    async login(password: string): Promise<string> {
      if (token) await this.logout();
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, credentials: "omit", redirect: "error", body: JSON.stringify({ password }) });
      const result = await response.json() as { token?: string; error?: string };
      if (!response.ok || !result.token) throw new Error(result.error ?? "登录失败。");
      token = result.token; return token;
    },
    async logout(): Promise<void> {
      if (!token) return;
      const previous = token; token = undefined;
      const response = await fetch("/api/auth/logout", { method: "POST", headers: { authorization: `Bearer ${previous}` }, credentials: "omit", redirect: "error" });
      if (!response.ok && response.status !== 401) throw new Error("退出登录失败。");
    },
  };
}

export interface GatewayManager {
  readonly navigation: WebUiNavigation;
  readonly onNew: () => void;
  dispose(): void;
}

export function createGatewayManager(client: UiClient): GatewayManager {
  let disposed = false;
  const activeDialogs = new Set<HTMLDialogElement>();

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
    if (disposed) {
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

    dialog.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault();
        dialog.close();
      }
    });

    dialog.addEventListener("close", () => {
      activeDialogs.delete(dialog);
      dialog.remove();
      if (previousActive && previousActive.isConnected) {
        previousActive.focus();
      }
    }, { once: true });

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
    if (disposed) return;
    const view = modal("操作未完成");
    view.fail(reason);
  }

  function button(label: string, action: () => unknown, className = "button") {
    const control = document.createElement("button");
    control.type = "button";
    control.className = className;
    control.textContent = label;
    control.addEventListener("click", () => {
      void Promise.resolve().then(action).catch(showError);
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
    view.form.onsubmit = event => {
      event.preventDefault();
      control.disabled = true;
      void action().then(() => view.dialog.close(), reason => {
        control.disabled = false;
        view.fail(reason);
      });
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
    const kind = choice(view, "聊天入口", [["", "仅通过控制端使用"], ["private", "平台私聊"], ["group", "平台群聊或话题"]]);
    const account = field(view, "平台账户 ID，例如 telegram:123456");
    const conversation = field(view, "聊天 ID");
    const owner = field(view, "私聊用户 ID");
    const threadId = field(view, "话题 ID（可选）");
    return () => kind.value ? {
      kind: kind.value,
      account: account.value.trim(),
      conversation: conversation.value.trim(),
      ...(kind.value === "private" ? { owner: owner.value.trim() } : {}),
      ...(threadId.value.trim() ? { threadId: threadId.value.trim() } : {}),
    } : undefined;
  }

  function agentChoices(view: ReturnType<typeof modal>, label: string, selected: readonly string[] = []) {
    const group = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = label;
    group.append(legend);
    const controls: HTMLInputElement[] = [];
    const fields = client.state.snapshot?.panels.find(panel => panel.id === "agents")?.fields ?? [];
    if (!fields.length) {
      const tip = document.createElement("p");
      tip.textContent = "当前尚未配置 Agent。";
      const add = button("添加 Agent", () => {
        view.dialog.close();
        void agents();
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
    return () => controls.filter(input => input.checked).map(input => input.value);
  }

  function createSession() {
    if (client.state.connection !== "connected") throw new Error("请连接服务后创建会话。");
    const view = modal("创建会话");
    const mode = choice(view, "创建方式", [["form", "图形化创建"], ["command", "直接使用命令创建"]]);
    const name = field(view, "会话名称");
    const agentsSelector = agentChoices(view, "默认 Agent（至少一个）");
    const allowedSelector = agentChoices(view, "其他免审批 Agent");
    const command = field(view, "创建命令", "/session create 新会话 --agent ", true);
    command.parentElement!.hidden = true;
    const entry = entryFields(view);
    mode.onchange = () => {
      name.parentElement!.hidden = mode.value === "command";
      for (const group of view.form.querySelectorAll("fieldset")) group.hidden = mode.value === "command";
      command.parentElement!.hidden = mode.value !== "command";
    };
    submit(view, "创建会话", async () => {
      const destination = entry();
      const args = destination ? { entry: JSON.stringify(destination) } : {};
      if (mode.value === "command") {
        if (!/^\/session\s+create\s/u.test(command.value.trim())) throw new Error("请输入 /session create 创建命令。");
        await client.command("gateway.command", { text: command.value, ...args }, null);
      } else {
        const defaults = agentsSelector();
        if (!name.value.trim() || !defaults.length) throw new Error("创建会话需要名称和至少一个默认 Agent。");
        await client.command("session.create", { name: name.value, agents: JSON.stringify(defaults), allowed: JSON.stringify(allowedSelector()), ...args }, null);
      }
    });
  }

  async function data(kind: string): Promise<unknown> {
    if (client.state.connection !== "connected") {
      throw new Error("服务未连接，请先输入密码连接本地服务。");
    }
    await client.command("gateway.inspect", { kind });
    if (!client.state.output?.text) throw new Error("获取管理数据失败。");
    return JSON.parse(client.state.output.text) as unknown;
  }

  async function tasks() {
    const inspectResult = await data("tasks") as { tasks?: GatewayTask[]; graphs?: unknown[] };
    if (disposed) return;
    const taskList = inspectResult.tasks ?? [];
    const view = modal("执行任务与协同");

    const summaryBar = document.createElement("div");
    summaryBar.className = "gateway-summary-bar";
    const runningCount = taskList.filter(t => t.status === "running").length;
    const failedCount = taskList.filter(t => ["failed", "cancelled", "recovery-required"].includes(t.status)).length;
    summaryBar.textContent = `总任务数：${taskList.length} · 运行中：${runningCount} · 异常与终止：${failedCount}`;
    view.insert(summaryBar);

    if (!taskList.length) {
      note(view, "当前服务没有记录的执行任务。");
    } else {
      for (const task of taskList) {
        const card = document.createElement("div");
        card.className = "gateway-card";

        const header = document.createElement("div");
        header.className = "gateway-card-header";
        const titleSpan = document.createElement("span");
        titleSpan.className = "gateway-card-title";
        titleSpan.textContent = `任务 ${task.id.slice(0, 16)} · ${task.agentId}`;
        header.append(titleSpan, statusPill(task.status));
        card.append(header);

        const meta = document.createElement("div");
        meta.className = "gateway-card-meta";
        meta.textContent = `会话：${task.sessionId}${task.graphId ? ` · 协作图 ${task.graphId}` : ""}${task.detail ? ` · ${task.detail}` : ""}`;
        card.append(meta);

        if (task.sessionId) {
          const cardActions = document.createElement("div");
          cardActions.className = "gateway-card-actions";
          cardActions.append(button("切换到该会话", async () => {
            await client.select(task.sessionId);
            view.dialog.close();
          }));
          card.append(cardActions);
        }
        view.insert(card);
      }
    }
    collapsibleJson(view, "原始任务诊断数据（JSON）", inspectResult);
  }

  async function settings() {
    const settingsData = await data("settings") as GatewaySettings;
    if (disposed) return;
    const view = modal("服务设置");

    const summaryBar = document.createElement("div");
    summaryBar.className = "gateway-summary-bar";
    const agentCount = Array.isArray(settingsData.agents) ? settingsData.agents.length : 0;
    const adminRulesCount = Object.keys(settingsData.access?.sessionAdmins ?? {}).length;
    summaryBar.textContent = `最大并发：${settingsData.maxConcurrent} · 配置 Agent：${agentCount} · 管理员规则：${adminRulesCount}`;
    view.insert(summaryBar);

    const configCard = document.createElement("div");
    configCard.className = "gateway-card";
    const meta = document.createElement("div");
    meta.className = "gateway-card-meta";
    meta.append(
      document.createTextNode(`反向代理公网来源：${settingsData.publicOrigin ?? "未配置反向代理公网来源"}`),
      document.createElement("br"),
      document.createTextNode(`最大并发任务数：${settingsData.maxConcurrent} 项`),
      document.createElement("br"),
      document.createTextNode(`空闲释放超时：${settingsData.idleMs} ms`),
      document.createElement("br"),
      document.createTextNode(`停机终止超时：${settingsData.shutdownMs} ms`),
      document.createElement("br"),
      document.createTextNode(`审批等待超时：${settingsData.approvalMs} ms`),
      document.createElement("br"),
      document.createTextNode(`配置会话管理员规则条数：${adminRulesCount} 条`),
      document.createElement("br"),
      document.createTextNode(`创建权限限制人数：${settingsData.access?.creators?.length ?? 0} 人`),
      document.createElement("br"),
      document.createTextNode(`禁止访问名单人数：${settingsData.access?.deniedUsers?.length ?? 0} 人`),
    );
    configCard.append(meta);
    view.insert(configCard);

    collapsibleJson(view, "原始服务设置数据（JSON）", settingsData);
  }

  async function channels() {
    type Delivery = { id: string; text: string; status: string };
    type ChannelEntry = { sessionId: string; name: string; entry: unknown };
    type ChannelDefault = { id: string; [key: string]: unknown };
    const value = await data("channels") as {
      host: { deliveries?: Delivery[]; channelReplies?: Delivery[]; legacyDeliveries?: Delivery[] };
      defaults?: ChannelDefault[];
      entries?: ChannelEntry[];
    };
    if (disposed) return;
    const view = modal("聊天渠道");

    const currentDeliveries = [...(value.host.deliveries ?? []), ...(value.host.channelReplies ?? [])];
    const legacyDeliveries = value.host.legacyDeliveries ?? [];
    const totalDeliveries = currentDeliveries.length + legacyDeliveries.length;
    const abnormalDeliveries = [...currentDeliveries, ...legacyDeliveries].filter(d => ["unknown", "failed"].includes(d.status));
    const entries = value.entries ?? [];
    const defaults = value.defaults ?? [];

    const summaryBar = document.createElement("div");
    summaryBar.className = "gateway-summary-bar";
    summaryBar.textContent = `消息投递：${totalDeliveries}（待重试 ${abnormalDeliveries.length}） · 绑定入口：${entries.length} · 默认规则：${defaults.length}`;
    view.insert(summaryBar);

    if (entries.length > 0) {
      const entriesHeading = document.createElement("h3");
      entriesHeading.textContent = "已绑定的聊天入口";
      entriesHeading.style.fontSize = "13px";
      entriesHeading.style.margin = "12px 0 6px";
      view.insert(entriesHeading);

      for (const item of entries) {
        const card = document.createElement("div");
        card.className = "gateway-card";
        const header = document.createElement("div");
        header.className = "gateway-card-header";
        const title = document.createElement("span");
        title.className = "gateway-card-title";
        title.textContent = `会话：${item.name} (${item.sessionId})`;
        header.append(title);
        card.append(header);

        const meta = document.createElement("div");
        meta.className = "gateway-card-meta";
        meta.textContent = `入口配置：${JSON.stringify(item.entry)}`;
        card.append(meta);

        const actions = document.createElement("div");
        actions.className = "gateway-card-actions";
        actions.append(button("切换到该会话", async () => {
          await client.select(item.sessionId);
          view.dialog.close();
        }));
        card.append(actions);
        view.insert(card);
      }
    }

    if (totalDeliveries > 0) {
      const deliveriesHeading = document.createElement("h3");
      deliveriesHeading.textContent = "消息投递与重试";
      deliveriesHeading.style.fontSize = "13px";
      deliveriesHeading.style.margin = "12px 0 6px";
      view.insert(deliveriesHeading);

      for (const [scope, deliveries] of [["current", currentDeliveries], ["legacy", legacyDeliveries]] as const) {
        for (const delivery of deliveries) {
          const card = document.createElement("div");
          card.className = "gateway-card";
          const header = document.createElement("div");
          header.className = "gateway-card-header";
          const title = document.createElement("span");
          title.className = "gateway-card-title";
          title.textContent = `投递 ${delivery.id.slice(0, 16)} · 作用域 ${scope}`;
          header.append(title, statusPill(delivery.status));
          card.append(header);

          const content = document.createElement("div");
          content.className = "gateway-card-meta";
          content.textContent = delivery.text;
          card.append(content);

          if (["unknown", "failed"].includes(delivery.status)) {
            const actions = document.createElement("div");
            actions.className = "gateway-card-actions";
            actions.append(button("重新发送消息", () => {
              const retry = modal("确认重新发送消息");
              note(retry, `${delivery.text}\n发送状态：${delivery.status}。重新发送可能在平台中产生重复消息。`);
              submit(retry, "确认重新发送", async () => {
                await client.command("delivery.retry", { id: delivery.id, scope, confirm: "true" });
                retry.dialog.close();
                view.dialog.close();
                void channels();
              });
            }));
            card.append(actions);
          }
          view.insert(card);
        }
      }
    } else if (!entries.length) {
      note(view, "当前服务没有记录的消息投递或已绑定聊天入口。");
    }

    collapsibleJson(view, "原始渠道诊断数据（JSON）", value);
  }

  async function sessions() {
    interface SessionItem {
      id: string;
      name: string;
      status: string;
      entry?: { account: string; conversation: string; threadId?: string };
    }
    const items = await data("sessions") as SessionItem[];
    if (disposed) return;
    const view = modal("会话筛选");
    const name = field(view, "搜索会话名称");
    const account = field(view, "筛选平台账户");
    const conversation = field(view, "筛选群聊或聊天 ID");
    const statusFilter = choice(view, "筛选会话状态", [["", "全部状态"], ["active", "活动"], ["archived", "归档"], ["deleting", "正在删除"]]);
    const list = document.createElement("div");
    view.insert(list);

    const render = () => {
      list.replaceChildren();
      const filtered = items.filter(item =>
        item.name.toLocaleLowerCase().includes(name.value.toLocaleLowerCase()) &&
        (!statusFilter.value || item.status === statusFilter.value) &&
        (!account.value || item.entry?.account.includes(account.value)) &&
        (!conversation.value || item.entry?.conversation.includes(conversation.value)),
      );
      for (const session of filtered) {
        const card = document.createElement("div");
        card.className = "gateway-card";
        const header = document.createElement("div");
        header.className = "gateway-card-header";
        const title = document.createElement("span");
        title.className = "gateway-card-title";
        title.textContent = session.name;
        header.append(title, statusPill(session.status));
        card.append(header);

        const meta = document.createElement("div");
        meta.className = "gateway-card-meta";
        meta.textContent = session.entry
          ? `${session.entry.account} / ${session.entry.conversation}${session.entry.threadId ? ` / ${session.entry.threadId}` : ""}`
          : "控制端专用会话";
        card.append(meta);

        const actions = document.createElement("div");
        actions.className = "gateway-card-actions";
        actions.append(button("切换至该会话", async () => {
          await client.select(session.id);
          view.dialog.close();
        }));
        card.append(actions);
        list.append(card);
      }
      if (!list.childElementCount) {
        const emptyHint = document.createElement("p");
        emptyHint.className = "detail-note";
        emptyHint.textContent = "没有符合筛选条件的会话。";
        list.append(emptyHint);
      }
    };
    for (const input of [name, account, conversation, statusFilter]) input.addEventListener("input", render);
    render();
    collapsibleJson(view, "原始会话列表数据（JSON）", items);
  }

  async function manageSession() {
    const id = client.state.snapshot?.selectedId;
    if (!id || id.startsWith("legacy:")) {
      createSession();
      return;
    }
    const sessionList = await data("sessions") as { id: string; name: string; defaultAgents: string[]; allowedAgents: string[]; entry?: unknown; status: string }[];
    if (disposed) return;
    const session = sessionList.find(item => item.id === id);
    if (!session) throw new Error("会话不存在。");

    const view = modal(`会话管理 · ${session.name}`);
    note(view, `会话 ID：${session.id}。默认 Agent 修改对所有入口生效。`);
    const name = field(view, "会话名称", session.name);
    const defaults = agentChoices(view, "默认 Agent", session.defaultAgents);
    const allowed = agentChoices(view, "免审批 Agent", session.allowedAgents);

    submit(view, "保存会话设置", async () => {
      await client.command("session.rename", { name: name.value }, id);
      await client.command("agent.default", { agents: JSON.stringify(defaults()) }, id);
      await client.command("agent.allow", { agents: JSON.stringify(allowed()) }, id);
    });

    view.actions.append(button("创建新会话", () => {
      view.dialog.close();
      createSession();
    }));

    if (session.entry) {
      view.actions.append(button("设为聊天入口默认会话", () => client.command("session.default", {}, id)));
    } else {
      view.actions.append(button("绑定聊天入口", () => {
        const binding = modal("绑定聊天入口");
        const entry = entryFields(binding);
        note(binding, "绑定后，该入口中获准参与的用户可以查询此会话的完整已有历史。平台主动发送绑定后的新消息。");
        submit(binding, "确认开放历史并绑定", async () => {
          const destination = entry();
          if (!destination) throw new Error("请选择平台私聊或群聊。");
          await client.command("session.bind", { entry: JSON.stringify(destination), confirm: "true" }, id);
        });
      }));
    }

    view.actions.append(button("配置会话管理员", () => {
      const adminDialog = modal("会话管理员");
      const identities = field(adminDialog, "平台身份，每行一个，例如 telegram:123456:789", "", true);
      submit(adminDialog, "保存管理员名单", () => client.command("session.admins", { admins: JSON.stringify(identities.value.split(/\r?\n/u).map(item => item.trim()).filter(Boolean)) }, id));
    }));

    view.actions.append(button(session.status === "archived" ? "恢复会话" : "归档会话", async () => {
      await client.command(session.status === "archived" ? "session.restore" : "session.archive", {}, id);
      view.dialog.close();
    }));

    view.actions.append(button("删除会话", () => {
      const deletion = modal("删除会话");
      note(deletion, `确认删除 ${session.name} 的 Gateway 记录、专用 Agent 对话和未发送消息？用户项目文件与平台已有消息继续保留。`);
      submit(deletion, "确认删除", async () => {
        await client.command("session.delete", { confirm: "true" }, id);
        view.dialog.close();
      });
    }));

    collapsibleJson(view, "原始会话配置数据（JSON）", session);
  }

  async function agents() {
    const configurations = await data("agents") as Record<string, unknown>[];
    const statuses = await data("agent-status") as { id: string; status: string }[];
    const bindings = await data("bindings") as { agentId: string; sessionId: string; conversationId?: string; status: string }[];
    if (disposed) return;

    const view = modal("Agent 管理");
    view.actions.append(button("添加 Agent", () => editor({ adapter: "may", enabled: true })));

    const summaryBar = document.createElement("div");
    summaryBar.className = "gateway-summary-bar";
    summaryBar.textContent = `已配置 Agent 数量：${configurations.length} · 活跃关联会话：${bindings.length}`;
    view.insert(summaryBar);

    if (!configurations.length) {
      note(view, "尚未配置 Agent。请点击“添加 Agent”进行添加。");
    } else {
      for (const config of configurations) {
        const card = document.createElement("div");
        card.className = "gateway-card";

        const header = document.createElement("div");
        header.className = "gateway-card-header";
        const title = document.createElement("span");
        title.className = "gateway-card-title";
        title.textContent = `${String(config.name ?? config.id)} (${String(config.id)})`;
        const currentStatus = statuses.find(agent => agent.id === config.id)?.status ?? (config.enabled === false ? "disabled" : "unloaded");
        header.append(title, statusPill(currentStatus));
        card.append(header);

        const meta = document.createElement("div");
        meta.className = "gateway-card-meta";
        meta.textContent = `适配器类型：${String(config.adapter)} · 关联状态：${currentStatus}`;
        card.append(meta);

        const cardBindings = bindings.filter(item => item.agentId === config.id);
        if (cardBindings.length) {
          const boundList = document.createElement("div");
          boundList.className = "gateway-card-meta";
          boundList.style.marginTop = "6px";
          boundList.append(document.createTextNode("关联对话："));
          for (const binding of cardBindings) {
            const linkBtn = button(`会话 ${binding.sessionId}`, async () => {
              await client.select(binding.sessionId);
              view.dialog.close();
            }, "text-button");
            boundList.append(linkBtn, document.createTextNode(` (${binding.status}) `));
          }
          card.append(boundList);
        }

        const actions = document.createElement("div");
        actions.className = "gateway-card-actions";
        actions.append(
          button("编辑", () => editor(config)),
          button("检查适配器", async () => {
            await client.command("agent.check", { id: String(config.id) });
            if (disposed) return;
            const result = modal("Agent 能力");
            note(result, client.state.output!.text);
          }),
        );
        card.append(actions);
        view.insert(card);
      }
    }
    collapsibleJson(view, "原始 Agent 数据（JSON）", { configurations, statuses, bindings });

    function editor(config: Record<string, unknown>) {
      const edit = modal("Agent 配置");
      const id = field(edit, "Agent ID", String(config.id ?? ""));
      if (config.id) id.readOnly = true;
      const nameField = field(edit, "显示名称", String(config.name ?? ""));
      const adapterChoice = choice(edit, "适配器", [["may", "May Agent"], ["module", "外部 Agent 模块"]]);
      adapterChoice.value = String(config.adapter);
      const enabledChoice = choice(edit, "状态", [["true", "启用"], ["false", "停用"]]);
      enabledChoice.value = String(config.enabled !== false);
      const modelField = field(edit, "May 模型配置名称", String(config.model ?? ""));
      const moduleField = field(edit, "外部适配器模块路径", String(config.module ?? ""));
      const exportedField = field(edit, "模块导出名称", String(config.export ?? ""));
      const instructionsField = field(edit, "Agent 指令", String(config.instructions ?? ""), true);
      const readDirectoryField = field(edit, "允许读取的目录", String(config.readDirectory ?? ""));
      const optionsField = field(edit, "适配器 options（JSON）", JSON.stringify(config.options ?? {}, null, 2), true);
      const permissionsField = field(edit, "工具 permissions（JSON）", JSON.stringify(config.permissions ?? {}, null, 2), true);
      const runBudgetField = field(edit, "执行 runBudget（JSON）", JSON.stringify(config.runBudget ?? {}, null, 2), true);
      const idleMsField = field(edit, "空闲释放毫秒数（可选）", String(config.idleMs ?? ""));

      submit(edit, "保存配置", async () => {
        const result: Record<string, unknown> = {
          ...config,
          id: id.value,
          adapter: adapterChoice.value,
          enabled: enabledChoice.value === "true",
          permissions: JSON.parse(permissionsField.value),
          runBudget: JSON.parse(runBudgetField.value),
        };
        for (const [key, input] of Object.entries({
          name: nameField,
          model: modelField,
          module: moduleField,
          export: exportedField,
          instructions: instructionsField,
          readDirectory: readDirectoryField,
        })) {
          if (input.value.trim()) result[key] = input.value;
          else delete result[key];
        }
        if (adapterChoice.value === "module") result.options = JSON.parse(optionsField.value);
        else for (const key of ["module", "export", "options"]) delete result[key];

        if (idleMsField.value.trim()) {
          const value = Number(idleMsField.value);
          if (!Number.isSafeInteger(value) || value < 0) throw new Error("空闲释放毫秒数需要非负整数。");
          result.idleMs = value;
        } else delete result.idleMs;

        await client.command("agent.save", { id: id.value, config: JSON.stringify(result) });
        edit.dialog.close();
        view.dialog.close();
        await agents();
      });

      if (config.id) {
        edit.actions.append(button("删除配置", () => {
          const deletion = modal("删除 Agent 配置");
          note(deletion, "只有已没有关联对话的 Agent 才能删除配置。");
          submit(deletion, "确认删除", async () => {
            await client.command("agent.delete", { id: String(config.id), confirm: "true" });
            deletion.dialog.close();
            edit.dialog.close();
            view.dialog.close();
            await agents();
          });
        }));
      }
    }
  }

  async function approvals() {
    interface ApprovalItem {
      id: string;
      sessionId: string;
      agentId: string;
      text: string;
      status: string;
      grantKey?: string;
    }
    const requests = await data("approvals") as ApprovalItem[];
    if (disposed) return;
    const view = modal("服务审批");

    const summaryBar = document.createElement("div");
    summaryBar.className = "gateway-summary-bar";
    const pendingCount = requests.filter(r => r.status === "pending").length;
    summaryBar.textContent = `全部审批项：${requests.length} · 待处理：${pendingCount}`;
    view.insert(summaryBar);

    if (!requests.length) {
      note(view, "当前服务没有等待处理的审批项。");
    } else {
      for (const request of requests) {
        const card = document.createElement("div");
        card.className = "gateway-card";

        const header = document.createElement("div");
        header.className = "gateway-card-header";
        const title = document.createElement("span");
        title.className = "gateway-card-title";
        title.textContent = `审批 ${request.id.slice(0, 16)} · 会话 ${request.sessionId}`;
        header.append(title, statusPill(request.status));
        card.append(header);

        const content = document.createElement("div");
        content.className = "gateway-card-meta";
        content.textContent = `Agent：${request.agentId}\n${request.text}`;
        card.append(content);

        if (request.status === "pending") {
          const actions = document.createElement("div");
          actions.className = "gateway-card-actions";
          for (const [decision, label] of [
            ["allow", "允许本次"],
            ...(request.grantKey ? [["allow-session", "允许该 Agent 对话中的同类操作"]] : []),
            ["deny", "拒绝"],
          ] as const) {
            actions.append(button(label, async () => {
              await client.command("approval.resolve", { id: request.id, decision });
              view.dialog.close();
              await approvals();
            }));
          }
          card.append(actions);
        }
        view.insert(card);
      }
    }
    collapsibleJson(view, "原始审批数据（JSON）", requests);
  }

  const navigation: WebUiNavigation = {
    groups: [
      {
        id: "sessions",
        title: "会话管理",
        items: [
          {
            id: "session-filter",
            label: "会话筛选",
            icon: "filter",
            action: () => sessions(),
          },
          {
            id: "session-manage",
            label: "会话管理",
            icon: "gear",
            action: () => manageSession(),
          },
        ],
      },
      {
        id: "agents-tasks",
        title: "Agent 与任务",
        items: [
          {
            id: "agents-manage",
            label: "Agent 管理",
            icon: "users",
            action: () => agents(),
          },
          {
            id: "tasks-inspect",
            label: "执行任务",
            icon: "task",
            action: () => tasks(),
          },
        ],
      },
      {
        id: "channels-system",
        title: "渠道与系统",
        items: [
          {
            id: "channels-manage",
            label: "聊天渠道",
            icon: "message",
            action: () => channels(),
          },
          {
            id: "approvals-manage",
            label: "服务审批",
            icon: "check",
            action: () => approvals(),
          },
          {
            id: "settings-manage",
            label: "服务设置",
            icon: "gear",
            action: () => settings(),
          },
        ],
      },
    ],
  };

  const manager: GatewayManager = {
    navigation: {
      ...navigation,
      render() {
        return {
          dispose() {
            manager.dispose();
          },
        };
      },
    },
    onNew: () => createSession(),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const dialog of activeDialogs) {
        dialog.close();
        dialog.remove();
      }
      activeDialogs.clear();
    },
  };

  return manager;
}
