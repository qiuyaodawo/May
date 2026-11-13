import type { UiClient } from "@sortedyuan/ui-client";
import type { GatewaySettings, GatewayTask } from "../gateway-types.js";
import type { GatewayBrowserContext } from "./dialogs.js";

export function createGatewayData(client: UiClient) {
  return async function data(kind: string): Promise<unknown> {
    if (client.state.connection !== "connected") {
      throw new Error("服务未连接，请先输入密码连接本地服务。");
    }
    await client.command("gateway.inspect", { kind });
    if (!client.state.output?.text) throw new Error("获取管理数据失败。");
    return JSON.parse(client.state.output.text) as unknown;
  };
}

export function createServicePages({ client, state, dialogs, data }: GatewayBrowserContext) {
  const { statusPill, modal, button, note, submit, collapsibleJson } = dialogs;

  async function tasks() {
    const inspectResult = (await data("tasks")) as { tasks?: GatewayTask[]; graphs?: unknown[] };
    if (state.disposed) return;
    const taskList = inspectResult.tasks ?? [];
    const view = modal("执行任务与协同");

    const summaryBar = document.createElement("div");
    summaryBar.className = "gateway-summary-bar";
    const runningCount = taskList.filter((t) => t.status === "running").length;
    const failedCount = taskList.filter((t) => ["failed", "cancelled", "recovery-required"].includes(t.status)).length;
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
          cardActions.append(
            button("切换到该会话", async () => {
              await client.select(task.sessionId);
              view.dialog.close();
            }),
          );
          card.append(cardActions);
        }
        view.insert(card);
      }
    }
    collapsibleJson(view, "原始任务诊断数据（JSON）", inspectResult);
  }

  async function settings() {
    const settingsData = (await data("settings")) as GatewaySettings;
    if (state.disposed) return;
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
    const value = (await data("channels")) as {
      host: { deliveries?: Delivery[]; channelReplies?: Delivery[] };
      defaults?: ChannelDefault[];
      entries?: ChannelEntry[];
    };
    if (state.disposed) return;
    const view = modal("聊天渠道");

    const currentDeliveries = [...(value.host.deliveries ?? []), ...(value.host.channelReplies ?? [])];
    const totalDeliveries = currentDeliveries.length;
    const abnormalDeliveries = currentDeliveries.filter((d) => ["unknown", "failed"].includes(d.status));
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
        actions.append(
          button("切换到该会话", async () => {
            await client.select(item.sessionId);
            view.dialog.close();
          }),
        );
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

      for (const delivery of currentDeliveries) {
        const card = document.createElement("div");
        card.className = "gateway-card";
        const header = document.createElement("div");
        header.className = "gateway-card-header";
        const title = document.createElement("span");
        title.className = "gateway-card-title";
        title.textContent = `投递 ${delivery.id.slice(0, 16)}`;
        header.append(title, statusPill(delivery.status));
        card.append(header);

        const content = document.createElement("div");
        content.className = "gateway-card-meta";
        content.textContent = delivery.text;
        card.append(content);

        if (["unknown", "failed"].includes(delivery.status)) {
          const actions = document.createElement("div");
          actions.className = "gateway-card-actions";
          actions.append(
            button("重新发送消息", () => {
              const retry = modal("确认重新发送消息");
              note(retry, `${delivery.text}\n发送状态：${delivery.status}。重新发送可能在平台中产生重复消息。`);
              submit(retry, "确认重新发送", async () => {
                await client.command("delivery.retry", { id: delivery.id, confirm: "true" });
                retry.dialog.close();
                view.dialog.close();
                await channels();
              });
            }),
          );
          card.append(actions);
        }
        view.insert(card);
      }
    } else if (!entries.length) {
      note(view, "当前服务没有记录的消息投递或已绑定聊天入口。");
    }

    collapsibleJson(view, "原始渠道诊断数据（JSON）", value);
  }

  return { tasks, settings, channels };
}
