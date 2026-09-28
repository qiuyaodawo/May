import { JsonFile } from "../state/json-file.js";
import { ensureCatalog, findService, type EhallCatalog } from "./catalog.js";
import { archiveSnapshot, prepareTransaction, shortDigest, type EhallConfirmation, type EhallPlanDependencies, type FormSnapshot, type TransactionPreparation } from "./plan.js";
import { EhallBrowser, type EhallBrowserSettings, type OpenResult } from "./browser.js";
import type { Vault } from "../vault/vault.js";

export const EHALL_STATE_FILE = "ehall/state.json";

export interface EhallState {
  readonly version: number;
  /** 用户确认过的表单摘要。 */
  readonly confirmation: EhallConfirmation | undefined;
  /** 助手填写过的字段名，用于在表单里标出。 */
  readonly filledFields: readonly string[];
  readonly lastServiceId: string | undefined;
  readonly lastUrl: string | undefined;
}

export interface EhallServiceDependencies {
  readonly vault: Vault;
  readonly browserSettings: EhallBrowserSettings;
  readonly stateFile: string;
}

export const EHALL_STATE_VERSION = 1;

export function emptyEhallState(): EhallState {
  return { version: EHALL_STATE_VERSION, confirmation: undefined, filledFields: [], lastServiceId: undefined, lastUrl: undefined };
}

export function parseEhallState(value: unknown): EhallState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("办事状态必须是对象");
  const record = value as Record<string, unknown>;
  if (record.version !== EHALL_STATE_VERSION) throw new Error(`办事状态版本不受支持：${String(record.version)}`);
  const confirmation = record.confirmation;
  if (confirmation !== undefined) {
    const item = confirmation as Record<string, unknown>;
    if (typeof item.serviceId !== "string" || typeof item.digest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(item.digest) || typeof item.confirmedAt !== "number") {
      throw new Error("办事状态中的确认记录无效");
    }
  }
  const filled = record.filledFields;
  if (!Array.isArray(filled) || filled.some((item) => typeof item !== "string")) {
    throw new Error("办事状态中的 filledFields 无效");
  }
  return {
    version: EHALL_STATE_VERSION,
    confirmation: confirmation as EhallConfirmation | undefined,
    filledFields: filled as string[],
    lastServiceId: typeof record.lastServiceId === "string" ? record.lastServiceId : undefined,
    lastUrl: typeof record.lastUrl === "string" ? record.lastUrl : undefined,
  };
}

/**
 * 办事大厅能力：查询信息、准备材料、按可及名称填写表单，
 * 提交前必须由用户确认字段摘要。不可撤销事务不提供提交。
 */
export class EhallService {
  private browser: EhallBrowser | undefined;
  private opening: Promise<EhallBrowser> | undefined;
  private readonly state: JsonFile<EhallState>;

  private constructor(
    private readonly dependencies: EhallServiceDependencies,
    state: JsonFile<EhallState>,
  ) {
    this.state = state;
  }

  static async open(dependencies: EhallServiceDependencies): Promise<EhallService> {
    const state = await JsonFile.open(dependencies.stateFile, emptyEhallState, parseEhallState);
    return new EhallService(dependencies, state);
  }

  async catalog(): Promise<EhallCatalog> {
    return ensureCatalog(this.dependencies.vault, this.dependencies.browserSettings.allowedHosts);
  }

  async prepare(serviceId: string): Promise<TransactionPreparation> {
    return prepareTransaction(this.planDependencies(), serviceId);
  }

  async open(serviceId: string): Promise<OpenResult> {
    const catalog = await this.catalog();
    const service = findService(catalog, serviceId);
    const browser = await this.launch();
    const result = await browser.open(service.url);
    await this.state.update((state) => ({ ...state, lastServiceId: serviceId, lastUrl: result.url }));
    return result;
  }

  async current(): Promise<OpenResult> {
    return (await this.launch()).describe();
  }

  async controls(): Promise<readonly { label: string; role: string; value: string; required: boolean }[]> {
    return (await this.launch()).controls();
  }

  async snapshotTree(): Promise<string> {
    return (await this.launch()).snapshotTree();
  }

  async screenshot(name: string): Promise<string> {
    return (await this.launch()).screenshot(name);
  }

  async fill(label: string, value: string): Promise<{ field: { label: string; role: string; value: string; required: boolean; filledByAssistant: boolean } }> {
    const field = await (await this.launch()).fill(label, value);
    await this.state.update((state) => ({
      ...state,
      filledFields: state.filledFields.includes(field.label) ? state.filledFields : [...state.filledFields, field.label],
      // 表单内容变化后旧确认立即失效。
      confirmation: undefined,
    }));
    return { field };
  }

  /** 读取当前表单，交给用户核对。 */
  async review(serviceId: string): Promise<FormSnapshot> {
    const service = findService(await this.catalog(), serviceId);
    const state = this.state.read();
    const snapshot = await (await this.launch()).review(serviceId, service.submitLabel);
    return {
      ...snapshot,
      submitLabel: service.submitLabel,
      fields: snapshot.fields.map((field) => ({
        ...field,
        filledByAssistant: state.filledFields.includes(field.label) || field.filledByAssistant,
      })),
    };
  }

  /** 用户核对字段后记录确认。只有完全一致的字段才能提交。 */
  async confirm(digest: string): Promise<EhallConfirmation> {
    const state = this.state.read();
    if (state.lastServiceId === undefined) throw new Error("还没有打开任何办事页面，无法确认表单");
    if (digest.length === 0) throw new Error("确认需要提供字段摘要");
    const snapshot = await this.review(state.lastServiceId);
    if (snapshot.digest !== digest) {
      throw new Error(
        `表单已经变化，确认摘要 ${shortDigest(digest)} 与当前 ${shortDigest(snapshot.digest)} 不一致，请重新核对`,
      );
    }
    const confirmation: EhallConfirmation = { serviceId: snapshot.serviceId, digest, confirmedAt: Date.now() };
    await this.state.update(() => ({ ...this.state.read(), confirmation }));
    return confirmation;
  }

  confirmation(): EhallConfirmation | undefined {
    return this.state.read().confirmation;
  }

  /** 当前浏览器停留的事务 id。 */
  async currentServiceId(): Promise<string | undefined> {
    return this.state.read().lastServiceId;
  }

  /**
   * 提交表单。不可撤销事务直接拒绝；
   * 其它事务必须先由用户确认当前字段摘要。
   */
  async submit(options: { screenshot?: string } = {}): Promise<{ result: OpenResult; file: string; screenshot: string | undefined }> {
    const state = this.state.read();
    const serviceId = state.lastServiceId;
    if (serviceId === undefined) throw new Error("还没有打开任何办事页面");
    const service = findService(await this.catalog(), serviceId);
    if (service.irreversible) {
      throw new Error(`${service.name} 属于不可撤销事务，助手不提供提交，请在浏览器窗口中由本人完成`);
    }
    const confirmation = state.confirmation;
    if (confirmation === undefined || confirmation.serviceId !== serviceId) {
      throw new Error("表单还没有被确认，请先用 ehall_review 展示字段并让用户确认");
    }
    const snapshot = await this.review(serviceId);
    if (snapshot.digest !== confirmation.digest) {
      throw new Error(
        `表单在确认之后发生了变化（确认 ${shortDigest(confirmation.digest)}，当前 ${shortDigest(snapshot.digest)}），` +
        "请重新核对并确认",
      );
    }
    const browser = await this.launch();
    const result = await browser.clickSubmit(service.submitLabel);
    const screenshot = options.screenshot === undefined ? undefined : await browser.screenshot(options.screenshot);
    const file = await archiveSnapshot(this.planDependencies(), snapshot, {
      submitted: true,
      note: `${service.name} 已点击「${service.submitLabel}」`,
    });
    await this.state.update(() => ({ ...this.state.read(), confirmation: undefined, filledFields: [] }));
    await this.dependencies.vault.git.commit(`提交 ${service.name} 表单`);
    return { result, file, screenshot };
  }

  /** 把当前表单状态归档到个人数据库，不提交。 */
  async archive(): Promise<{ file: string; snapshot: FormSnapshot }> {
    const state = this.state.read();
    const serviceId = state.lastServiceId;
    if (serviceId === undefined) throw new Error("还没有打开任何办事页面");
    const snapshot = await this.review(serviceId);
    const file = await archiveSnapshot(this.planDependencies(), snapshot, {
      submitted: false,
      note: "已核对字段，尚未提交",
    });
    await this.dependencies.vault.git.commit(`归档 ${serviceId} 表单`);
    return { file, snapshot };
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    this.opening = undefined;
    if (browser !== undefined) await browser.close();
  }

  private planDependencies(): EhallPlanDependencies {
    return { vault: this.dependencies.vault, allowedHosts: this.dependencies.browserSettings.allowedHosts };
  }

  private async launch(): Promise<EhallBrowser> {
    if (this.browser !== undefined) return this.browser;
    this.opening ??= EhallBrowser.launch(this.dependencies.browserSettings).then((browser) => {
      this.browser = browser;
      this.opening = undefined;
      return browser;
    }, (error: unknown) => {
      this.opening = undefined;
      throw error;
    });
    return this.opening;
  }
}
