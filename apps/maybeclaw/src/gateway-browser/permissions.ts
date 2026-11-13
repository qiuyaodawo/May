import type { GatewaySettings } from "../gateway-types.js";
import type { GatewayBrowserContext } from "./dialogs.js";

export function createPermissionPages({ client, state, dialogs, data }: GatewayBrowserContext) {
  const { statusPill, modal, button, note, collapsibleJson } = dialogs;

  async function approvals() {
    interface ApprovalItem {
      id: string;
      sessionId: string;
      agentId: string;
      text: string;
      status: string;
      grantKey?: string;
      persistent?: { description: string };
    }
    const requests = (await data("approvals")) as ApprovalItem[];
    if (state.disposed) return;
    const view = modal("服务审批");

    const summaryBar = document.createElement("div");
    summaryBar.className = "gateway-summary-bar";
    const pendingCount = requests.filter((r) => r.status === "pending").length;
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
            ...(request.persistent ? [["allow-persistent", "保存持久允许规则"]] : []),
            ["deny", "拒绝"],
          ] as const) {
            actions.append(
              button(label, async () => {
                await client.command("approval.resolve", { id: request.id, decision });
                view.dialog.close();
                await approvals();
              }),
            );
          }
          card.append(actions);
        }
        view.insert(card);
      }
    }
    collapsibleJson(view, "原始审批数据（JSON）", requests);
  }

  async function permissionRules() {
    const settingsData = (await data("settings")) as GatewaySettings;
    if (state.disposed) return;
    if (!settingsData.persistentRules) {
      const view = modal("持久权限规则");
      note(view, "apps.maybeclaw.persistentRules 尚未启用。");
      return;
    }
    const rules = (await data("permission-rules")) as Array<{
      id: string;
      description: string;
      decision: string;
      createdBy: string;
      createdAt: number;
      expiresAt?: number;
    }>;
    if (state.disposed) return;
    const view = modal("持久权限规则");
    if (!rules.length) note(view, "当前服务没有持久权限规则。");
    for (const rule of rules) {
      const card = document.createElement("div");
      card.className = "gateway-card";
      const content = document.createElement("div");
      content.className = "gateway-card-meta";
      content.textContent = `${rule.id}\n${rule.description}\n决定：${rule.decision} · 创建者：${rule.createdBy} · 创建时间：${new Date(rule.createdAt).toISOString()}${rule.expiresAt === undefined ? "" : ` · 过期时间：${new Date(rule.expiresAt).toISOString()}`}`;
      card.append(
        content,
        button(rule.decision === "allow" ? "保存相同范围的禁止规则" : "保存相同范围的允许规则", async () => {
          await client.command("permission.rule.create", {
            sourceId: rule.id,
            decision: rule.decision === "allow" ? "deny" : "allow",
          });
          view.dialog.close();
          await permissionRules();
        }),
        button("撤销规则", async () => {
          await client.command("permission.rule.revoke", { id: rule.id });
          view.dialog.close();
          await permissionRules();
        }),
      );
      view.insert(card);
    }
    note(view, "禁止规则优先于允许规则。恢复允许操作需要撤销匹配的禁止规则。");
    collapsibleJson(view, "规则数据（JSON）", rules);
  }

  return { approvals, permissionRules };
}
