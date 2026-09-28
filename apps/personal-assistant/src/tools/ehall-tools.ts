import type { Tool } from "@may/core";
import type { EhallService } from "../ehall/service.js";
import { shortDigest } from "../ehall/plan.js";
import { defineTool, optionalString, readObject, requiredString } from "./define.js";

export function createEhallTools(ehall: EhallService): readonly Tool[] {
  const services = defineTool<Record<string, never>, { services: readonly unknown[] }>({
    name: "ehall_services",
    description:
      "列出办事大厅里已配置的事务、地址、需要的材料，以及哪些事务不可撤销。" +
      "不可撤销事务（例如退课、撤销申请）只准备材料与表单，提交必须由本人完成。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    parse(input) {
      readObject(input, "ehall_services");
      return {};
    },
    async execute() {
      const catalog = await ehall.catalog();
      return {
        services: catalog.services.map((service) => ({
          id: service.id,
          name: service.name,
          category: service.category,
          url: service.url,
          irreversible: service.irreversible,
          submitLabel: service.submitLabel,
          materials: service.materials,
          note: service.note,
        })),
      };
    },
  });

  const prepare = defineTool<{ serviceId: string }, {
    service: unknown;
    materials: readonly unknown[];
    missing: readonly string[];
    canSubmit: boolean;
    reason: string | undefined;
  }>({
    name: "ehall_prepare",
    description: "检查某个事务需要的材料是否已经在个人数据库里，返回缺失的材料清单。",
    inputSchema: { type: "object", properties: { serviceId: { type: "string" } }, required: ["serviceId"], additionalProperties: false },
    parse(input) {
      const record = readObject(input, "ehall_prepare");
      return { serviceId: requiredString(record, "serviceId", "ehall_prepare", 64) };
    },
    async execute(input) {
      const result = await ehall.prepare(input.serviceId);
      return {
        service: { id: result.service.id, name: result.service.name, irreversible: result.service.irreversible },
        materials: result.materials,
        missing: result.missing,
        canSubmit: result.canSubmit,
        reason: result.reason,
      };
    },
  });

  const open = defineTool<{ serviceId: string }, { url: string; title: string; loginRequired: boolean; text: string }>({
    name: "ehall_open",
    description: "在浏览器中打开某个事务页面并返回页面文字。需要登录时先在浏览器窗口里完成登录。",
    inputSchema: { type: "object", properties: { serviceId: { type: "string" } }, required: ["serviceId"], additionalProperties: false },
    parse(input) {
      const record = readObject(input, "ehall_open");
      return { serviceId: requiredString(record, "serviceId", "ehall_open", 64) };
    },
    async execute(input) {
      return ehall.open(input.serviceId);
    },
  });

  const page = defineTool<Record<string, never>, { url: string; title: string; text: string; tree: string }>({
    name: "ehall_page",
    description: "读取当前办事页面的文字与无障碍结构，用于了解页面上有哪些操作。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    parse(input) {
      readObject(input, "ehall_page");
      return {};
    },
    async execute() {
      const current = await ehall.current();
      return { ...current, tree: await ehall.snapshotTree() };
    },
  });

  const controls = defineTool<Record<string, never>, { fields: readonly unknown[] }>({
    name: "ehall_controls",
    description: "列出当前页面上可以填写的字段，包括字段名称、类型、是否必填和当前值。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    parse(input) {
      readObject(input, "ehall_controls");
      return {};
    },
    async execute() {
      return { fields: await ehall.controls() };
    },
  });

  const fill = defineTool<{ label: string; value: string }, { field: unknown }>({
    name: "ehall_fill",
    description:
      "按页面上的字段名称填写一个字段。选择框要填选项名称，复选框填「是」或「否」。" +
      "只填写，不提交。填写后旧的用户确认立即失效。",
    inputSchema: {
      type: "object",
      properties: { label: { type: "string" }, value: { type: "string" } },
      required: ["label", "value"],
      additionalProperties: false,
    },
    parse(input) {
      const record = readObject(input, "ehall_fill");
      return {
        label: requiredString(record, "label", "ehall_fill", 200),
        value: requiredString(record, "value", "ehall_fill", 2_000),
      };
    },
    async execute(input) {
      return ehall.fill(input.label, input.value);
    },
  });

  const review = defineTool<{ serviceId: string }, {
    url: string;
    title: string;
    digest: string;
    shortDigest: string;
    submitLabel: string;
    fields: readonly unknown[];
    confirmed: boolean;
    note: string;
  }>({
    name: "ehall_review",
    description:
      "读取当前表单的全部字段，生成字段摘要。请把字段表原样展示给用户，核对后再让用户确认。" +
      "摘要就是用户确认和提交时必须一致的内容。",
    inputSchema: { type: "object", properties: { serviceId: { type: "string" } }, required: ["serviceId"], additionalProperties: false },
    parse(input) {
      const record = readObject(input, "ehall_review");
      return { serviceId: requiredString(record, "serviceId", "ehall_review", 64) };
    },
    async execute(input) {
      const snapshot = await ehall.review(input.serviceId);
      const confirmation = ehall.confirmation();
      const empty = snapshot.fields.filter((field) => field.value === "").map((field) => field.label);
      return {
        url: snapshot.url,
        title: snapshot.title,
        digest: snapshot.digest,
        shortDigest: shortDigest(snapshot.digest),
        submitLabel: snapshot.submitLabel,
        confirmed: confirmation?.digest === snapshot.digest,
        fields: snapshot.fields.map((field) => ({
          label: field.label,
          type: field.role,
          required: field.required,
          filledByAssistant: field.filledByAssistant,
          value: field.value,
        })),
        note: empty.length === 0
          ? "请用户核对这些字段，并说明提交后的后果。"
          : `还有必填或未填字段：${empty.join("、")}。请先补齐再让用户确认。`,
      };
    },
  });

  const archive = defineTool<Record<string, never>, { file: string; digest: string }>({
    name: "ehall_archive",
    description: "把当前表单字段表归档到个人数据库，不提交。用于记录已经核对但还没提交的内容。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    parse(input) {
      readObject(input, "ehall_archive");
      return {};
    },
    async execute() {
      const result = await ehall.archive();
      return { file: result.file, digest: result.snapshot.digest };
    },
  });

  const submit = defineTool<{ serviceId: string; screenshot?: string }, {
    serviceId: string;
    file: string;
    screenshot: string | undefined;
    result: unknown;
  }>({
    name: "ehall_submit",
    description:
      "提交办事表单。只有用户已经确认过当前字段摘要、并且字段此后没有变化时才会提交。" +
      "退课、撤销申请等不可撤销事务会被直接拒绝。请在提交前向用户说明后果。",
    inputSchema: {
      type: "object",
      properties: { serviceId: { type: "string" }, screenshot: { type: "string" } },
      required: ["serviceId"],
      additionalProperties: false,
    },
    parse(input) {
      const record = readObject(input, "ehall_submit");
      return {
        serviceId: requiredString(record, "serviceId", "ehall_submit", 64),
        ...(optionalString(record, "screenshot", "ehall_submit") === undefined
          ? {}
          : { screenshot: optionalString(record, "screenshot", "ehall_submit", 64)! }),
      };
    },
    async execute(input) {
      const state = await ehall.currentServiceId();
      if (state !== input.serviceId) {
        throw new Error(`当前页面是 ${state ?? "（无）"}，与 ${input.serviceId} 不一致，请先用 ehall_open 打开该事务`);
      }
      const result = await ehall.submit({
        ...(input.screenshot === undefined ? {} : { screenshot: input.screenshot }),
      });
      return {
        serviceId: input.serviceId,
        file: result.file,
        screenshot: result.screenshot,
        result: { url: result.result.url, title: result.result.title, text: result.result.text.slice(0, 2_000) },
      };
    },
  });

  return [services, prepare, open, page, controls, fill, review, archive, submit];
}
