import type { AgentWorkspace } from "@may/application";
import { UiError, type UiCommand, type UiPanel, type UiReceipt } from "@may/ui-client";
import { shortDigest } from "../ehall/plan.js";
import type { AssistantContext } from "../context.js";

export const PRODUCT_COMMANDS = [
  "mailbox.check",
  "mailbox.status",
  "draft.list",
  "draft.update",
  "draft.confirm",
  "ehall.review",
  "ehall.confirm",
  "vault.reindex",
] as const;

/** 用户可以在运行过程中执行的命令：改草稿、确认草稿、确认表单。 */
export const CONCURRENT_COMMANDS = ["draft.list", "draft.update", "draft.confirm", "mailbox.status", "ehall.review"] as const;

export interface CommandOutcome {
  readonly title: string;
  readonly message: string;
  readonly data?: unknown;
}

export interface ProductUiOptions {
  readonly context: AssistantContext;
  readonly workspace: AgentWorkspace;
}

export interface ProductUiHandlers {
  readonly product: {
    id: string;
    title: string;
    subtitle: string;
    resourceKind: "session";
    suggestions: readonly string[];
  };
  readonly panels: () => Promise<readonly UiPanel[]>;
  readonly commands: readonly string[];
  readonly concurrentCommands: readonly string[];
  readonly available: (name: string) => boolean;
  readonly execute: (command: UiCommand) => Promise<UiReceipt>;
}

/**
 * 手机与网页上的产品命令。发送邮件与提交办事表单不在这里：
 * 那两件事必须由助手在会话里发起，并经过审批。
 */
export function createProductUi(options: ProductUiOptions): ProductUiHandlers {
  const { context, workspace } = options;  return {
    product: {
      id: "personal-assistant",
      title: "个人助手",
      subtitle: "个人数据库、邮箱与办事大厅共用一份上下文。手机上可以发起任务、查看进度、编辑草稿并确认操作。",
      resourceKind: "session",
      suggestions: [
        "检查邮箱里的新邮件并起草回复",
        "这封通知需要哪些材料",
        "把办事大厅的表单准备好，不要提交",
      ],
    },
    commands: [...PRODUCT_COMMANDS],
    concurrentCommands: [...CONCURRENT_COMMANDS],
    available: (name) => {
      if (name === "mailbox.check") return context.mailAvailable;
      return true;
    },
    panels: async () => {
      const pending = context.mailbox.ledger().pending();
      const vault = await context.vault.status();
      const confirmation = context.ehall.confirmation();
      const fields = [
        { label: "个人数据库", value: `${vault.root}（${vault.files} 个文件）` },
        {
          label: "邮箱",
          value: context.mailAvailable
            ? `${pending.unhandledMail} 封未处理 · ${pending.drafts} 份草稿（${pending.confirmed} 份已确认）`
            : "未配置",
        },
        { label: "办事大厅", value: confirmation === undefined ? "没有待确认的表单" : `已确认表单 ${shortDigest(confirmation.digest)}` },
      ];
      return [{ id: "assistant", title: "个人助手", fields }];
    },
    execute: async (command) => {
      const outcome = await runCommand({ context, workspace }, command);
      return {
        selectedId: workspace.sessionId,
        output: { title: outcome.title, text: JSON.stringify({ message: outcome.message, data: outcome.data ?? null }) },
      };
    },
  };
}

async function runCommand(
  deps: { readonly context: AssistantContext; readonly workspace: AgentWorkspace },
  command: UiCommand,
): Promise<CommandOutcome> {
  const { context, workspace } = deps;
  switch (command.name) {
    case "mailbox.status": {
      const pending = context.mailbox.ledger().pending();
      return { title: "邮箱状态", message: "已读取邮箱账本", data: { ...pending, configured: context.mailAvailable } };
    }
    case "mailbox.check": {
      if (!context.mailAvailable) throw new UiError(409, "没有配置邮箱");
      const result = await context.mailbox.check({});
      if (result.newMessages.length === 0) {
        return { title: "邮箱检查", message: "没有新邮件", data: { known: result.knownMessages } };
      }
      await workspace.submit({
        input: [
          `邮箱有 ${result.newMessages.length} 封新邮件，请按流程处理：`,
          ...result.newMessages.map((message) => `- ${message.from}：${message.subject}（key: ${message.key}）`),
          "先 mail_thread 了解往来，再检索个人数据库，最后起草回复。不要直接发送。",
        ].join("\n"),
        inputId: `mailbox:${result.checkedAt}`,
      });
      return {
        title: "邮箱检查",
        message: `发现 ${result.newMessages.length} 封新邮件，已交给助手处理`,
        data: { newMessages: result.newMessages.map((message) => ({ key: message.key, subject: message.subject })) },
      };
    }
    case "draft.list": {
      const views = await context.mailbox.listDraftViews({ state: "draft", limit: 20 });
      return {
        title: "待发送草稿",
        message: `共 ${views.length} 份草稿`,
        data: {
          drafts: views.map((view) => ({
            id: view.record.id,
            subject: view.content.subject,
            to: view.content.to,
            body: view.content.body,
            digest: shortDigest(view.record.digest),
            confirmed: view.confirmed,
          })),
        },
      };
    }
    case "draft.update": {
      const id = requiredArg(command, "id");
      const body = optionalArg(command, "body");
      const subject = optionalArg(command, "subject");
      if (body === undefined && subject === undefined) throw new UiError(400, "请提供 body 或 subject");
      const view = await context.mailbox.updateDraft(id, {
        ...(body === undefined ? {} : { body }),
        ...(subject === undefined ? {} : { subject }),
      });
      return {
        title: "草稿已更新",
        message: view.confirmed ? "草稿内容与确认版本一致" : "内容已改动，需要重新确认",
        data: { id: view.record.id, digest: shortDigest(view.record.digest), confirmed: view.confirmed },
      };
    }
    case "draft.confirm": {
      const id = requiredArg(command, "id");
      const view = await context.mailbox.confirmDraft(id);
      return {
        title: "草稿已确认",
        message: `已确认 ${view.record.id}，助手现在可以发送这一版`,
        data: { id: view.record.id, digest: shortDigest(view.record.digest), subject: view.content.subject, to: view.content.to },
      };
    }
    case "ehall.review": {
      const current = await context.ehall.currentServiceId();
      const serviceId = command.args.serviceId?.trim() || current;
      if (serviceId === undefined || serviceId === "") {
        throw new UiError(409, "还没有打开任何办事页面，请先让助手打开事务页面");
      }
      const snapshot = await context.ehall.review(serviceId);
      return {
        title: "表单字段",
        message: `共 ${snapshot.fields.length} 个字段，摘要 ${shortDigest(snapshot.digest)}`,
        data: {
          serviceId: snapshot.serviceId,
          digest: snapshot.digest,
          shortDigest: shortDigest(snapshot.digest),
          submitLabel: snapshot.submitLabel,
          fields: snapshot.fields.map((field) => ({
            label: field.label,
            role: field.role,
            required: field.required,
            filledByAssistant: field.filledByAssistant,
            value: field.value,
          })),
        },
      };
    }
    case "ehall.confirm": {
      const digest = requiredArg(command, "digest");
      const confirmation = await context.ehall.confirm(digest);
      return {
        title: "表单已确认",
        message: `已确认 ${confirmation.serviceId} 的字段摘要 ${shortDigest(confirmation.digest)}`,
        data: { serviceId: confirmation.serviceId, digest: confirmation.digest },
      };
    }
    case "vault.reindex": {
      const result = await context.vault.sync();
      await context.vault.git.commit("重新索引个人数据库");
      return {
        title: "索引已更新",
        message: `新增 ${result.added.length} · 更新 ${result.updated.length} · 删除 ${result.removed.length} · 共 ${result.total}`,
        data: { ...result },
      };
    }
    default:
      throw new UiError(400, `未实现的命令：${command.name}`);
  }
}

function requiredArg(command: UiCommand, key: string): string {
  const value = command.args[key]?.trim();
  if (value === undefined || value === "") throw new UiError(400, `命令 ${command.name} 缺少参数 ${key}`);
  return value;
}

function optionalArg(command: UiCommand, key: string): string | undefined {
  const value = command.args[key];
  return value === undefined || value === "" ? undefined : value;
}
