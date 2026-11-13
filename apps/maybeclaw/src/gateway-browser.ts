import type { UiClient } from "@sortedyuan/ui-client";
import type { WebUiNavigation } from "@sortedyuan/web-ui";
import { createAgentsPage } from "./gateway-browser/agents.js";
import {
  createGatewayDialogs,
  type GatewayBrowserContext,
  type GatewayBrowserState,
} from "./gateway-browser/dialogs.js";
import { createPermissionPages } from "./gateway-browser/permissions.js";
import { createGatewayData, createServicePages } from "./gateway-browser/service.js";
import { createSessionPages } from "./gateway-browser/sessions.js";

export function gatewayAuthentication() {
  let token: string | undefined;
  return {
    label: "管理员密码",
    async login(password: string): Promise<string> {
      if (token) await this.logout();
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "omit",
        redirect: "error",
        body: JSON.stringify({ password }),
      });
      const result = (await response.json()) as { token?: string; error?: string };
      if (!response.ok || !result.token) throw new Error(result.error ?? "登录失败。");
      token = result.token;
      return token;
    },
    async logout(): Promise<void> {
      if (!token) return;
      const previous = token;
      token = undefined;
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        headers: { authorization: `Bearer ${previous}` },
        credentials: "omit",
        redirect: "error",
      });
      if (!response.ok && response.status !== 401) throw new Error("退出登录失败。");
    },
  };
}

export interface GatewayManager {
  readonly navigation: WebUiNavigation;
  readonly onNew: () => void;
  dispose(): Promise<void>;
}

export function createGatewayManager(client: UiClient): GatewayManager {
  let closing: Promise<void> | undefined;
  const state: GatewayBrowserState = {
    disposed: false,
    activeDialogs: new Set<HTMLDialogElement>(),
    pendingActions: new Set<Promise<void>>(),
    actionErrors: [],
  };
  const dialogs = createGatewayDialogs(client, state, () => agents());
  const context: GatewayBrowserContext = { client, state, dialogs, data: createGatewayData(client) };
  const { createSession, sessions, manageSession } = createSessionPages(context);
  const agents = createAgentsPage(context);
  const { tasks, settings, channels } = createServicePages(context);
  const { approvals, permissionRules } = createPermissionPages(context);

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
            id: "permission-rules-manage",
            label: "持久权限规则",
            icon: "check",
            action: () => permissionRules(),
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
            return manager.dispose();
          },
        };
      },
    },
    onNew: () => createSession(),
    dispose() {
      return (closing ??= closeDialogs());
    },
  };

  return manager;

  async function closeDialogs(): Promise<void> {
    state.disposed = true;
    for (const dialog of state.activeDialogs) {
      dialog.close();
      dialog.remove();
    }
    state.activeDialogs.clear();
    while (state.pendingActions.size) await Promise.all(state.pendingActions);
    if (state.actionErrors.length) throw new AggregateError(state.actionErrors, "Gateway management actions failed");
  }
}
