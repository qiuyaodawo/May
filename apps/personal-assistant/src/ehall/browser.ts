import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import type { FormFieldState, FormSnapshot } from "./plan.js";
import { formDigest } from "./plan.js";

export interface EhallBrowserSettings {
  /** 浏览器用户目录，登录状态保存在这里。 */
  readonly profileDirectory: string;
  readonly headless: boolean;
  readonly timeoutMs: number;
  /** 允许访问的办事大厅域名，其它地址一律拒绝。 */
  readonly allowedHosts: readonly string[];
}

export interface OpenResult {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly loginRequired: boolean;
}

export class EhallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EhallError";
  }
}

const LOGIN_HINTS = [/统一身份认证/u, /请输入密码/u, /netid/u, /captcha/u, /login/u];
const MAX_PAGE_TEXT = 20_000;

/**
 * 用真实浏览器操作办事大厅。只读取页面、按可及名称填写字段，
 * 提交由 ehall_submit 单独执行，并且需要用户确认字段摘要。
 */
export class EhallBrowser {
  private constructor(
    private readonly context: BrowserContext,
    private readonly settings: EhallBrowserSettings,
    private page: Page,
  ) {}

  static async launch(settings: EhallBrowserSettings): Promise<EhallBrowser> {
    if (settings.timeoutMs < 1_000 || settings.timeoutMs > 600_000) {
      throw new EhallError("浏览器超时时间应在 1 秒到 10 分钟之间");
    }
    await mkdir(settings.profileDirectory, { recursive: true });
    const context = await chromium.launchPersistentContext(settings.profileDirectory, {
      headless: settings.headless,
      viewport: { width: 1280, height: 900 },
      locale: "zh-CN",
      args: ["--disable-blink-features=AutomationControlled"],
    });
    context.setDefaultTimeout(settings.timeoutMs);
    const page = context.pages()[0] ?? await context.newPage();
    return new EhallBrowser(context, settings, page);
  }

  async open(url: string): Promise<OpenResult> {
    this.assertAllowedUrl(url);
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
    await this.page.waitForLoadState("networkidle").catch(() => undefined);
    return this.describe();
  }

  /** 页面可交互控件清单，按可及名称排列，助手据此决定填写哪些字段。 */
  async controls(): Promise<readonly FormFieldState[]> {
    return this.collectFields([]);
  }

  /** 页面无障碍树快照，供助手了解当前页面结构。 */
  async snapshotTree(): Promise<string> {
    return this.page.locator("body").ariaSnapshot({ timeout: this.settings.timeoutMs });
  }

  async fill(label: string, value: string): Promise<FormFieldState> {
    const locator = await this.locate(label);
    const tag = await locator.evaluate((node) => node.tagName.toLowerCase());
    if (tag === "select") {
      const option = value.trim();
      const count = await locator.locator("option", { hasText: option }).count();
      if (count === 0) {
        const options = await locator.locator("option").allTextContents();
        throw new EhallError(`下拉框「${label}」没有选项 ${option}，可选：${options.map((item) => item.trim()).filter(Boolean).join("、")}`);
      }
      await locator.selectOption({ label: option });
    } else if (tag === "input" && isCheckbox(await locator.getAttribute("type"))) {
      await locator.setChecked(parseBoolean(value));
    } else if (tag === "input" && (await locator.getAttribute("type")) === "radio") {
      await locator.check();
    } else {
      await locator.fill(value);
    }
    await this.page.waitForTimeout(150);
    return this.fieldState(label, true);
  }

  /** 读取当前表单状态。提交前展示给用户的就是这份内容。 */
  async review(serviceId: string, submitLabel: string): Promise<FormSnapshot> {
    const fields = await this.collectFields([]);
    const url = this.page.url();
    return {
      url,
      serviceId,
      title: await this.page.title(),
      fields,
      submitLabel,
      digest: formDigest({ url, serviceId, submitLabel, fields }),
      capturedAt: Date.now(),
    };
  }

  async clickSubmit(submitLabel: string): Promise<OpenResult> {
    const byRole = this.page.getByRole("button", { name: submitLabel, exact: true });
    const byText = this.page.getByText(submitLabel, { exact: true });
    const roleCount = await byRole.count();
    const textCount = await byText.count();
    if (roleCount === 1) await byRole.click();
    else if (roleCount === 0 && textCount === 1) await byText.click();
    else if (roleCount === 0 && textCount === 0) {
      throw new EhallError(`页面上找不到提交控件：${submitLabel}`);
    } else {
      throw new EhallError(`提交控件「${submitLabel}」在页面上不唯一，请先核对页面`);
    }
    await this.page.waitForLoadState("networkidle").catch(() => undefined);
    return this.describe();
  }

  async screenshot(name: string): Promise<string> {
    if (!/^[a-z0-9-]{1,64}$/u.test(name)) throw new EhallError("截图名称只能使用小写字母、数字和连字符");
    const directory = join(this.settings.profileDirectory, "..", "screenshots");
    await mkdir(directory, { recursive: true });
    const file = join(directory, `${name}.png`);
    await this.page.screenshot({ path: file, fullPage: true });
    return file;
  }

  async describe(): Promise<OpenResult> {
    const url = this.page.url();
    const text = (await this.page.locator("body").innerText()).replace(/\n{3,}/gu, "\n\n").trim();
    return {
      url,
      title: await this.page.title(),
      text: text.length > MAX_PAGE_TEXT ? `${text.slice(0, MAX_PAGE_TEXT)}\n…（页面内容已截断）` : text,
      loginRequired: LOGIN_HINTS.some((hint) => hint.test(url) || hint.test(text.slice(0, 500))),
    };
  }

  async close(): Promise<void> {
    await this.context.close();
  }

  /** 只允许配置的办事大厅域名；回环地址用于本地验证。 */
  private assertAllowedUrl(url: string): void {
    const parsed = new URL(url);
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
    if (parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:")) {
      throw new EhallError("办事大厅只允许 https 地址");
    }
    const allowed = this.settings.allowedHosts.some((host) =>
      parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
    if (!allowed && !loopback) {
      throw new EhallError(`只允许访问 ${this.settings.allowedHosts.join("、")}，收到 ${parsed.hostname}`);
    }
  }

  /** 按可及名称定位控件：名称必须唯一，匹配不到就报错。 */
  private async locate(label: string): Promise<Locator> {
    const name = label.trim();
    if (name === "") throw new EhallError("字段名称不能为空");
    const candidates: Locator[] = [
      this.page.getByLabel(name, { exact: true }),
      this.page.getByRole("textbox", { name, exact: true }),
      this.page.getByRole("combobox", { name, exact: true }),
      this.page.getByRole("checkbox", { name, exact: true }),
      this.page.getByRole("radio", { name, exact: true }),
      this.page.getByPlaceholder(name, { exact: true }),
    ];
    for (const candidate of candidates) {
      const count = await candidate.count();
      if (count === 1) return candidate;
      if (count > 1) throw new EhallError(`字段「${name}」在页面上不唯一，请改用更完整的名称`);
    }
    throw new EhallError(`页面上找不到字段「${name}」，请先用 ehall_controls 查看可填写字段`);
  }

  private async fieldState(label: string, filledByAssistant: boolean): Promise<FormFieldState> {
    return readField(await this.locate(label), filledByAssistant);
  }

  private async collectFields(filled: readonly string[]): Promise<readonly FormFieldState[]> {
    const count = await this.page.locator("input, select, textarea").count();
    const fields: FormFieldState[] = [];
    for (let index = 0; index < count; index += 1) {
      const locator = this.page.locator("input, select, textarea").nth(index);
      const state = await readField(locator, false).catch(() => undefined);
      if (state === undefined || state.label === "") continue;
      fields.push(filled.includes(state.label) ? { ...state, filledByAssistant: true } : state);
    }
    return fields;
  }
}

async function readField(locator: Locator, filledByAssistant: boolean): Promise<FormFieldState> {
  const information = await locator.evaluate((node) => {
    const element = node as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    const tag = element.tagName.toLowerCase();
    const type = element.getAttribute("type") ?? "";
    if (["hidden", "submit", "button", "image", "reset"].includes(type)) return undefined;
    const labels = "labels" in element && element.labels !== null && element.labels !== undefined
      ? [...element.labels].map((label) => label.textContent?.trim() ?? "")
      : [];
    const name = element.getAttribute("aria-label")
      ?? labels.find((label) => label !== "")
      ?? element.getAttribute("placeholder")
      ?? element.getAttribute("name")
      ?? "";
    const selected = tag === "select"
      ? [...(element as HTMLSelectElement).selectedOptions].map((option) => option.textContent?.trim() ?? "").join("、")
      : type === "checkbox"
        ? (element as HTMLInputElement).checked ? "是" : "否"
        : (element as HTMLInputElement | HTMLTextAreaElement).value;
    return {
      label: name,
      role: tag === "select" ? "select" : type === "checkbox" ? "checkbox" : type === "radio" ? "radio" : tag,
      value: (selected ?? "").slice(0, 2_000),
      required: element.required === true || element.getAttribute("aria-required") === "true",
    };
  });
  if (information === undefined) throw new EhallError("该控件不是可填写字段");
  return { ...information, filledByAssistant };
}

function isCheckbox(type: string | null): boolean {
  return type === "checkbox";
}

function parseBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "1", "是", "勾选", "选中"].includes(normalized)) return true;
  if (["false", "no", "0", "否", "不选", "取消"].includes(normalized)) return false;
  throw new EhallError(`无法把 ${value} 理解为勾选状态`);
}
