import type { PermissionPolicy } from "@may/permissions";
import { findService, loadCatalog } from "./ehall/catalog.js";
import type { Vault } from "./vault/vault.js";

const ALLOWED = new Set([
  "vault_search",
  "vault_read",
  "vault_list",
  "vault_write",
  "vault_remove",
  "vault_commit",
  "mail_check",
  "mail_thread",
  "mail_draft_create",
  "mail_draft_update",
  "mail_draft_list",
  "mail_send",
  "mail_archive",
  "mail_status",
  "ehall_services",
  "ehall_prepare",
  "ehall_open",
  "ehall_page",
  "ehall_controls",
  "ehall_fill",
  "ehall_review",
  "ehall_archive",
  "ehall_submit",
  "rule_learn",
  "rule_list",
  "skill_learn",
]);

export interface PermissionPolicyOptions {
  readonly vault: Vault;
}

/**
 * 工具权限：读取与准备直接允许，会造成外部影响的操作逐次询问，
 * 不可撤销的办事事务直接拒绝提交。
 */
export function createPermissionPolicy(options: PermissionPolicyOptions): PermissionPolicy {
  return async ({ tool, input }) => {
    if (!ALLOWED.has(tool.name)) return "deny";
    if (tool.name === "vault_remove") {
      return { decision: "ask", grantKey: `vault.remove:${JSON.stringify(input)}` };
    }
    if (tool.name === "mail_send") {
      const id = readId(input);
      return { decision: "ask", grantKey: `mail.send:${id}` };
    }
    if (tool.name === "ehall_submit") {
      const serviceId = readId(input);
      const catalog = await loadCatalog(options.vault);
      const service = findService(catalog, serviceId);
      if (service.irreversible) return "deny";
      return { decision: "ask", grantKey: `ehall.submit:${serviceId}` };
    }
    return "allow";
  };
}

function readId(input: unknown): string {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const value = (input as Record<string, unknown>).id ?? (input as Record<string, unknown>).serviceId;
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "unknown";
}
