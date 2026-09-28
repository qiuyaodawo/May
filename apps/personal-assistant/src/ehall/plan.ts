import { createHash } from "node:crypto";
import { formatMarkdown } from "../vault/frontmatter.js";
import type { Vault } from "../vault/vault.js";
import { ensureCatalog, findService, type EhallService } from "./catalog.js";

export interface FormFieldState {
  /** 页面上的可及名称，助手按它定位控件。 */
  readonly label: string;
  readonly role: string;
  readonly value: string;
  readonly required: boolean;
  readonly filledByAssistant: boolean;
}

export interface FormSnapshot {
  readonly url: string;
  readonly serviceId: string;
  readonly title: string;
  readonly fields: readonly FormFieldState[];
  readonly submitLabel: string;
  /** 字段、提交按钮与地址的摘要，用户确认的就是这个值。 */
  readonly digest: string;
  readonly capturedAt: number;
}

export interface MaterialStatus {
  readonly path: string;
  readonly note: string | undefined;
  readonly present: boolean;
  readonly title: string | undefined;
}

export interface TransactionPreparation {
  readonly service: EhallService;
  readonly materials: readonly MaterialStatus[];
  readonly missing: readonly string[];
  readonly canSubmit: boolean;
  readonly reason: string | undefined;
}
export interface EhallConfirmation {
  readonly serviceId: string;
  readonly digest: string;
  readonly confirmedAt: number;
}

export function formDigest(input: {
  url: string;
  serviceId: string;
  submitLabel: string;
  fields: readonly FormFieldState[];
}): string {
  return createHash("sha256").update(JSON.stringify({
    url: input.url,
    serviceId: input.serviceId,
    submitLabel: input.submitLabel,
    fields: input.fields.map((field) => [field.label, field.role, field.value, field.required]),
  })).digest("hex");
}

export function shortDigest(digest: string): string {
  return digest.slice(0, 12);
}

export interface EhallPlanDependencies {
  readonly vault: Vault;
  readonly allowedHosts: readonly string[];
}

/** 读取事务需要的材料清单，标出个人数据库里还缺哪些。 */
export async function prepareTransaction(
  dependencies: EhallPlanDependencies,
  serviceId: string,
): Promise<TransactionPreparation> {
  const service = findService(await ensureCatalog(dependencies.vault, dependencies.allowedHosts), serviceId);
  const materials: MaterialStatus[] = [];
  for (const material of service.materials) {
    const entry = await dependencies.vault.entry(material.path).catch(() => undefined);
    materials.push({
      path: material.path,
      note: material.note,
      present: entry !== undefined,
      title: entry?.title,
    });
  }
  const missing = materials.filter((material) => !material.present).map((material) => material.path);
  return {
    service,
    materials,
    missing,
    canSubmit: !service.irreversible,
    reason: service.irreversible
      ? `${service.name} 属于不可撤销事务，助手只准备材料与表单，提交必须由本人完成`
      : missing.length === 0
        ? undefined
        : `个人数据库还缺少材料：${missing.join("、")}`,
  };
}

/** 把提交前的字段表与材料清单归档到个人数据库。 */
export async function archiveSnapshot(
  dependencies: EhallPlanDependencies,
  snapshot: FormSnapshot,
  outcome: { submitted: boolean; note: string },
): Promise<string> {
  const service = (await ensureCatalog(dependencies.vault, dependencies.allowedHosts))
    .services.find((item) => item.id === snapshot.serviceId);
  const file = `ehall/forms/${new Date(snapshot.capturedAt).toISOString().slice(0, 10)}-${snapshot.serviceId}-${shortDigest(snapshot.digest)}.md`;
  const lines = [
    `事务：${service?.name ?? snapshot.serviceId}${service?.irreversible === true ? "（不可撤销）" : ""}`,
    `页面：${snapshot.url}`,
    `提交按钮：${snapshot.submitLabel ?? "未配置"}`,
    `字段摘要：${snapshot.digest}`,
    `结果：${outcome.submitted ? "已提交" : "未提交"} · ${outcome.note}`,
    "",
    "| 字段 | 类型 | 必填 | 助手填写 | 当前值 |",
    "| --- | --- | --- | --- | --- |",
    ...snapshot.fields.map((field) =>
      `| ${field.label} | ${field.role} | ${field.required ? "是" : "否"} | ${field.filledByAssistant ? "是" : "否"} | ${field.value === "" ? "（空）" : field.value.replace(/\|/gu, "\\|")} |`),
    "",
  ];
  await dependencies.vault.write(file, formatMarkdown({
    title: `${service?.name ?? snapshot.serviceId} 表单`,
    tags: ["ehall", "form", outcome.submitted ? "submitted" : "reviewed"],
    service: snapshot.serviceId,
    digest: snapshot.digest,
    url: snapshot.url,
    capturedAt: new Date(snapshot.capturedAt).toISOString(),
    submitted: outcome.submitted,
  }, lines.join("\n")));
  return file;
}
