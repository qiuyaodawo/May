import type { GatewayBrowserContext } from "./dialogs.js";

export function createAgentsPage({ client, state, dialogs, data }: GatewayBrowserContext) {
  const { statusPill, modal, button, field, choice, note, submit, collapsibleJson } = dialogs;

  async function agents() {
    const configurations = (await data("agents")) as Record<string, unknown>[];
    const statuses = (await data("agent-status")) as { id: string; status: string }[];
    const bindings = (await data("bindings")) as {
      agentId: string;
      sessionId: string;
      conversationId?: string;
      status: string;
    }[];
    if (state.disposed) return;

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
        const currentStatus =
          statuses.find((agent) => agent.id === config.id)?.status ??
          (config.enabled === false ? "disabled" : "unloaded");
        header.append(title, statusPill(currentStatus));
        card.append(header);

        const meta = document.createElement("div");
        meta.className = "gateway-card-meta";
        meta.textContent = `适配器类型：${String(config.adapter)} · 关联状态：${currentStatus}`;
        card.append(meta);

        const cardBindings = bindings.filter((item) => item.agentId === config.id);
        if (cardBindings.length) {
          const boundList = document.createElement("div");
          boundList.className = "gateway-card-meta";
          boundList.style.marginTop = "6px";
          boundList.append(document.createTextNode("关联对话："));
          for (const binding of cardBindings) {
            const linkBtn = button(
              `会话 ${binding.sessionId}`,
              async () => {
                await client.select(binding.sessionId);
                view.dialog.close();
              },
              "text-button",
            );
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
            if (state.disposed) return;
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
      const adapterChoice = choice(edit, "适配器", [
        ["may", "May Agent"],
        ["module", "外部 Agent 模块"],
      ]);
      adapterChoice.value = String(config.adapter);
      const enabledChoice = choice(edit, "状态", [
        ["true", "启用"],
        ["false", "停用"],
      ]);
      enabledChoice.value = String(config.enabled !== false);
      const modelField = field(edit, "May 模型配置名称", String(config.model ?? ""));
      const moduleField = field(edit, "外部适配器模块路径", String(config.module ?? ""));
      const exportedField = field(edit, "模块导出名称", String(config.export ?? ""));
      const instructionsField = field(edit, "Agent 指令", String(config.instructions ?? ""), true);
      const readDirectoryField = field(edit, "允许读取的目录", String(config.readDirectory ?? ""));
      const optionsField = field(edit, "适配器 options（JSON）", JSON.stringify(config.options ?? {}, null, 2), true);
      const permissionsField = field(
        edit,
        "工具 permissions（JSON）",
        JSON.stringify(config.permissions ?? {}, null, 2),
        true,
      );
      const runBudgetField = field(
        edit,
        "执行 runBudget（JSON）",
        JSON.stringify(config.runBudget ?? {}, null, 2),
        true,
      );
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
        if (adapterChoice.value === "module") {
          result.options = JSON.parse(optionsField.value);
          delete result.plugins;
        } else for (const key of ["module", "export", "options"]) delete result[key];

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
        edit.actions.append(
          button("删除配置", () => {
            const deletion = modal("删除 Agent 配置");
            note(deletion, "只有已没有关联对话的 Agent 才能删除配置。");
            submit(deletion, "确认删除", async () => {
              await client.command("agent.delete", { id: String(config.id), confirm: "true" });
              deletion.dialog.close();
              edit.dialog.close();
              view.dialog.close();
              await agents();
            });
          }),
        );
      }
    }
  }

  return agents;
}
