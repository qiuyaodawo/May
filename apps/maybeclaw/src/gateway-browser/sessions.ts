import type { GatewayBrowserContext } from "./dialogs.js";

export function createSessionPages({ client, state, dialogs, data }: GatewayBrowserContext) {
  const { statusPill, modal, button, field, choice, note, submit, collapsibleJson, entryFields, agentChoices } =
    dialogs;

  function createSession() {
    if (client.state.connection !== "connected") throw new Error("请连接服务后创建会话。");
    const view = modal("创建会话");
    const mode = choice(view, "创建方式", [
      ["form", "图形化创建"],
      ["command", "直接使用命令创建"],
    ]);
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
        await client.command(
          "session.create",
          { name: name.value, agents: JSON.stringify(defaults), allowed: JSON.stringify(allowedSelector()), ...args },
          null,
        );
      }
    });
  }

  async function sessions() {
    interface SessionItem {
      id: string;
      name: string;
      status: string;
      entry?: { account: string; conversation: string; threadId?: string };
    }
    const items = (await data("sessions")) as SessionItem[];
    if (state.disposed) return;
    const view = modal("会话筛选");
    const name = field(view, "搜索会话名称");
    const account = field(view, "筛选平台账户");
    const conversation = field(view, "筛选群聊或聊天 ID");
    const statusFilter = choice(view, "筛选会话状态", [
      ["", "全部状态"],
      ["active", "活动"],
      ["archived", "归档"],
      ["deleting", "正在删除"],
    ]);
    const list = document.createElement("div");
    view.insert(list);

    const render = () => {
      list.replaceChildren();
      const filtered = items.filter(
        (item) =>
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
        actions.append(
          button("切换至该会话", async () => {
            await client.select(session.id);
            view.dialog.close();
          }),
        );
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
    if (!id) {
      createSession();
      return;
    }
    const sessionList = (await data("sessions")) as {
      id: string;
      name: string;
      defaultAgents: string[];
      allowedAgents: string[];
      entry?: unknown;
      status: string;
    }[];
    if (state.disposed) return;
    const session = sessionList.find((item) => item.id === id);
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

    view.actions.append(
      button("创建新会话", () => {
        view.dialog.close();
        createSession();
      }),
    );

    if (session.entry) {
      view.actions.append(button("设为聊天入口默认会话", () => client.command("session.default", {}, id)));
    } else {
      view.actions.append(
        button("绑定聊天入口", () => {
          const binding = modal("绑定聊天入口");
          const entry = entryFields(binding);
          note(binding, "绑定后，该入口中获准参与的用户可以查询此会话的完整已有历史。平台主动发送绑定后的新消息。");
          submit(binding, "确认开放历史并绑定", async () => {
            const destination = entry();
            if (!destination) throw new Error("请选择平台私聊或群聊。");
            await client.command("session.bind", { entry: JSON.stringify(destination), confirm: "true" }, id);
          });
        }),
      );
    }

    view.actions.append(
      button("配置会话管理员", () => {
        const adminDialog = modal("会话管理员");
        const identities = field(adminDialog, "平台身份，每行一个，例如 telegram:123456:789", "", true);
        submit(adminDialog, "保存管理员名单", () =>
          client.command(
            "session.admins",
            {
              admins: JSON.stringify(
                identities.value
                  .split(/\r?\n/u)
                  .map((item) => item.trim())
                  .filter(Boolean),
              ),
            },
            id,
          ),
        );
      }),
    );

    view.actions.append(
      button(session.status === "archived" ? "恢复会话" : "归档会话", async () => {
        await client.command(session.status === "archived" ? "session.restore" : "session.archive", {}, id);
        view.dialog.close();
      }),
    );

    view.actions.append(
      button("删除会话", () => {
        const deletion = modal("删除会话");
        note(
          deletion,
          `确认删除 ${session.name} 的 Gateway 记录、专用 Agent 对话和未发送消息？用户项目文件与平台已有消息继续保留。`,
        );
        submit(deletion, "确认删除", async () => {
          await client.command("session.delete", { confirm: "true" }, id);
          view.dialog.close();
        });
      }),
    );

    collapsibleJson(view, "原始会话配置数据（JSON）", session);
  }

  return { createSession, sessions, manageSession };
}
