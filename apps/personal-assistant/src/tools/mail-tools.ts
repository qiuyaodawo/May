import type { Tool } from "@may/core";
import type { Mailbox } from "../mail/mailbox.js";
import { shortDigest } from "../mail/types.js";
import { defineTool, optionalNumber, optionalString, optionalStringList, readObject, requiredString } from "./define.js";

export function createMailTools(mailbox: Mailbox): readonly Tool[] {
  const check = defineTool<{ limit?: number }, {
    checkedAt: string;
    newMessages: readonly unknown[];
    knownMessages: number;
    note: string;
  }>({
    name: "mail_check",
    description:
      "检查邮箱有没有新邮件。已经处理过的邮件不会再次返回，也不会被重复处理。" +
      "先调用它，再对每封新邮件调用 mail_thread 了解上下文。",
    inputSchema: { type: "object", properties: { limit: { type: "number" } }, additionalProperties: false },
    parse(input) {
      const record = readObject(input, "mail_check");
      return optionalNumber(record, "limit", "mail_check") === undefined
        ? {}
        : { limit: optionalNumber(record, "limit", "mail_check")! };
    },
    async execute(input) {
      const result = await mailbox.check({ ...(input.limit === undefined ? {} : { limit: input.limit }) });
      return {
        checkedAt: new Date(result.checkedAt).toISOString(),
        knownMessages: result.knownMessages,
        newMessages: result.newMessages.map((message) => ({
          key: message.key,
          from: message.from,
          subject: message.subject,
          date: message.date,
          hasAttachments: message.hasAttachments,
          preview: message.preview,
        })),
        note: result.newMessages.length === 0
          ? "没有新邮件。不要重复处理账本里已有的邮件。"
          : `新邮件 ${result.newMessages.length} 封，请逐封处理。`,
      };
    },
  });

  const thread = defineTool<{ key: string }, { message: unknown; history: readonly unknown[] }>({
    name: "mail_thread",
    description: "取回一封邮件的完整往来记录，用于理解上下文、称呼和历史承诺。",
    inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false },
    parse(input) {
      const record = readObject(input, "mail_thread");
      return { key: requiredString(record, "key", "mail_thread", 400) };
    },
    async execute(input) {
      const result = await mailbox.thread(input.key);
      return {
        message: {
          key: result.message.key,
          from: result.message.from,
          subject: result.message.subject,
          date: result.message.date,
          state: result.message.state,
          preview: result.message.preview,
          draftId: result.message.draftId,
        },
        history: result.history.map((item) => ({
          date: item.date,
          direction: item.direction,
          from: item.from,
          subject: item.subject,
          text: item.text.slice(0, 4_000),
        })),
      };
    },
  });

  const createDraft = defineTool<{
    key?: string;
    to: readonly string[];
    cc?: readonly string[];
    subject: string;
    body: string;
  }, { draftId: string; digest: string; confirmed: boolean; file: string }>({
    name: "mail_draft_create",
    description:
      "为某封邮件创建回复草稿，或创建一封新邮件草稿。草稿只写入个人数据库，不会发出。" +
      "发送必须由用户在手机或命令行确认后再执行 mail_send。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        to: { type: "array", items: { type: "string" } },
        cc: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
    parse(input) {
      const record = readObject(input, "mail_draft_create");
      const to = optionalStringList(record, "to", "mail_draft_create");
      if (to === undefined || to.length === 0) throw new TypeError("mail_draft_create 缺少参数 to");
      const cc = optionalStringList(record, "cc", "mail_draft_create");
      return {
        to,
        ...(cc === undefined ? {} : { cc }),
        subject: requiredString(record, "subject", "mail_draft_create", 500),
        body: requiredString(record, "body", "mail_draft_create", 512 * 1024),
        ...(optionalString(record, "key", "mail_draft_create") === undefined
          ? {}
          : { key: optionalString(record, "key", "mail_draft_create")! }),
      };
    },
    async execute(input) {
      const view = await mailbox.createDraft({
        to: input.to,
        ...(input.cc === undefined ? {} : { cc: input.cc }),
        subject: input.subject,
        body: input.body,
        ...(input.key === undefined ? {} : { inReplyTo: input.key }),
      });
      return {
        draftId: view.record.id,
        digest: view.record.digest,
        confirmed: view.confirmed,
        file: view.record.file,
        note: "草稿已保存到个人数据库，等待用户核对确认。助手不能代替用户确认。",
      };
    },
  });

  const updateDraft = defineTool<{
    id: string;
    to?: readonly string[];
    cc?: readonly string[];
    subject?: string;
    body?: string;
  }, { draftId: string; digest: string; confirmed: boolean; revision: number }>({
    name: "mail_draft_update",
    description: "修改草稿内容。内容变化后用户此前的确认立即失效，需要重新确认才能发送。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        to: { type: "array", items: { type: "string" } },
        cc: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    parse(input) {
      const record = readObject(input, "mail_draft_update");
      const to = optionalStringList(record, "to", "mail_draft_update");
      const cc = optionalStringList(record, "cc", "mail_draft_update");
      return {
        id: requiredString(record, "id", "mail_draft_update", 64),
        ...(to === undefined ? {} : { to }),
        ...(cc === undefined ? {} : { cc }),
        ...(optionalString(record, "subject", "mail_draft_update") === undefined
          ? {}
          : { subject: optionalString(record, "subject", "mail_draft_update", 500)! }),
        ...(optionalString(record, "body", "mail_draft_update") === undefined
          ? {}
          : { body: optionalString(record, "body", "mail_draft_update", 512 * 1024)! }),
      };
    },
    async execute(input) {
      const view = await mailbox.updateDraft(input.id, {
        ...(input.to === undefined ? {} : { to: input.to }),
        ...(input.cc === undefined ? {} : { cc: input.cc }),
        ...(input.subject === undefined ? {} : { subject: input.subject }),
        ...(input.body === undefined ? {} : { body: input.body }),
      });
      return {
        draftId: view.record.id,
        digest: view.record.digest,
        confirmed: view.confirmed,
        revision: view.record.revision,
      };
    },
  });

  const listDrafts = defineTool<{ state?: "draft" | "sent" | "archived" }, { drafts: readonly unknown[] }>({
    name: "mail_draft_list",
    description: "列出草稿及其确认状态。只有 confirmed 为 true 的草稿才允许发送。",
    inputSchema: { type: "object", properties: { state: { type: "string" } }, additionalProperties: false },
    parse(input) {
      const record = readObject(input, "mail_draft_list");
      const state = optionalString(record, "state", "mail_draft_list");
      if (state !== undefined && !["draft", "sent", "archived"].includes(state)) {
        throw new TypeError("mail_draft_list 的 state 只能是 draft、sent 或 archived");
      }
      return state === undefined ? {} : { state: state as "draft" | "sent" | "archived" };
    },
    async execute(input) {
      const drafts = await mailbox.listDraftViews({
        ...(input.state === undefined ? {} : { state: input.state }),
        limit: 20,
      });
      return {
        drafts: drafts.map((view) => ({
          draftId: view.record.id,
          file: view.record.file,
          subject: view.content.subject,
          to: view.content.to,
          state: view.record.state,
          confirmed: view.confirmed,
          digest: shortDigest(view.record.digest),
          updatedAt: new Date(view.record.updatedAt).toISOString(),
        })),
      };
    },
  });

  const send = defineTool<{ id: string }, { draftId: string; sent: boolean; messageId: string | undefined }>({
    name: "mail_send",
    description:
      "发送一封已经被用户确认过的草稿，发送内容与确认时完全一致。" +
      "未确认的草稿会被拒绝；发送前会再次请求用户批准。",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    parse(input) {
      const record = readObject(input, "mail_send");
      return { id: requiredString(record, "id", "mail_send", 64) };
    },
    async execute(input) {
      const result = await mailbox.sendDraft(input.id);
      return {
        draftId: result.record.id,
        sent: !result.alreadySent,
        messageId: result.sent?.messageId ?? result.record.sentMessageId,
        note: result.alreadySent ? "这封草稿之前已经发送过，没有重复发送。" : "邮件已发送，并归档到个人数据库。",
      };
    },
  });

  const archive = defineTool<{ key: string; note?: string }, { key: string; file: string; state: string }>({
    name: "mail_archive",
    description: "把一封邮件正文归档到个人数据库，并把账本里的这封邮件标记为已处理。",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, note: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
    },
    parse(input) {
      const record = readObject(input, "mail_archive");
      return {
        key: requiredString(record, "key", "mail_archive", 400),
        ...(optionalString(record, "note", "mail_archive") === undefined
          ? {}
          : { note: optionalString(record, "note", "mail_archive", 2_000)! }),
      };
    },
    async execute(input) {
      const result = await mailbox.archiveMessage(input.key, input.note);
      return { key: input.key, file: result.file, state: result.state };
    },
  });

  const status = defineTool<Record<string, never>, {
    configured: boolean;
    address: string | null;
    counts: unknown;
    watermark: string | null;
  }>({
    name: "mail_status",
    description: "查看邮箱是否配置、还有多少邮件和草稿没有处理。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    parse(input) {
      readObject(input, "mail_status");
      return {};
    },
    async execute() {
      const ledger = mailbox.ledger();
      const watermark = ledger.watermark();
      return {
        configured: mailbox.configured,
        address: mailbox.address() ?? null,
        counts: ledger.pending(),
        watermark: watermark === undefined ? null : new Date(watermark).toISOString(),
      };
    },
  });

  return [check, thread, createDraft, updateDraft, listDrafts, send, archive, status];
}
