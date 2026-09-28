import { formatMarkdown, parseMarkdown } from "../vault/frontmatter.js";
import type { Vault } from "../vault/vault.js";

export const EHALL_CATALOG_FILE = "ehall/services.md";
export const DEFAULT_ALLOWED_HOSTS = ["ehall.nju.edu.cn"];

export interface EhallMaterial {
  /** 个人数据库中的相对路径，助手会检查它是否存在。 */
  readonly path: string;
  readonly note: string | undefined;
}

export interface EhallService {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly category: string;
  /** 提交后无法自行撤销的事务，助手只准备材料与表单，不提供提交。 */
  readonly irreversible: boolean;
  /** 提交按钮在页面上的可及名称，提交前会显示给用户核对。 */
  readonly submitLabel: string;
  readonly materials: readonly EhallMaterial[];
  readonly note: string | undefined;
}

export interface EhallCatalog {
  readonly services: readonly EhallService[];
}

/**
 * 内置办事目录。保存在 vault/ehall/services.md 的 frontmatter 里，
 * 用户可以直接阅读和修改；新增自己的事务只要照着现有格式写一条即可。
 */
const DEFAULT_SERVICES: readonly EhallService[] = [
  {
    id: "transcript",
    name: "成绩单打印申请",
    category: "教学",
    url: "https://ehall.nju.edu.cn/fw/xszz/jw/index.do",
    irreversible: false,
    submitLabel: "提交申请",
    materials: [{ path: "records/transcript.md", note: "成绩单用途与份数" }],
    note: "教务处受理后按工作日出具。",
  },
  {
    id: "certificate-reissue",
    name: "证件补办",
    category: "校园服务",
    url: "https://ehall.nju.edu.cn/fw/xlzx/index.do",
    irreversible: false,
    submitLabel: "提交",
    materials: [
      { path: "people/self.md", note: "姓名、学号、证件号" },
      { path: "records/id-photo.md", note: "证件照片文件位置" },
    ],
    note: "补办后原证件作废，需要重新领取。",
  },
  {
    id: "dorm-repair",
    name: "宿舍报修",
    category: "后勤",
    url: "https://ehall.nju.edu.cn/fw/hq/fw/index.do",
    irreversible: false,
    submitLabel: "提交",
    materials: [{ path: "people/self.md", note: "宿舍楼与房间号" }],
    note: undefined,
  },
  {
    id: "course-withdraw",
    name: "退课申请",
    category: "教学",
    url: "https://ehall.nju.edu.cn/fw/xszz/jw/tk/index.do",
    irreversible: true,
    submitLabel: "提交",
    materials: [{ path: "people/self.md", note: "学号与课程信息" }],
    note: "退课影响学分与培养方案，助手只准备材料，提交必须由本人完成。",
  },
  {
    id: "application-withdraw",
    name: "撤销申请",
    category: "通用",
    url: "https://ehall.nju.edu.cn/fw/index.do",
    irreversible: true,
    submitLabel: "提交",
    materials: [{ path: "people/self.md", note: "需要撤销的申请名称" }],
    note: "撤销后可能无法重新申请，助手只准备材料，提交必须由本人完成。",
  },
];

const CATALOG_BODY = [
  "这里列出助手可以准备材料与填写表单的办事事务。",
  "",
  "- 每条事务需要 `id`、`name`、`category`、`url`、`submitLabel`。",
  "- `irreversible: true` 表示提交后无法自行撤销，助手不会提交这类事务。",
  "- `materials` 里的路径是个人数据库中的 Markdown 文件，助手会检查是否已经准备好。",
  "- 新增事务时照着现有格式写一条即可，保存后助手在下次会话中就能看到。",
  "",
].join("\n");

export class EhallCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EhallCatalogError";
  }
}

export async function ensureCatalog(
  vault: Vault,
  allowedHosts: readonly string[] = DEFAULT_ALLOWED_HOSTS,
): Promise<EhallCatalog> {
  if (await vault.exists(EHALL_CATALOG_FILE)) return loadCatalog(vault, allowedHosts);
  const source = formatCatalog(DEFAULT_SERVICES);
  const catalog = parseCatalog(source, allowedHosts);
  await vault.write(EHALL_CATALOG_FILE, source);
  return catalog;
}

export async function loadCatalog(
  vault: Vault,
  allowedHosts: readonly string[] = DEFAULT_ALLOWED_HOSTS,
): Promise<EhallCatalog> {
  const read = await vault.read(EHALL_CATALOG_FILE);
  return parseCatalog(read.text, allowedHosts);
}

export function parseCatalog(
  source: string,
  allowedHosts: readonly string[] = DEFAULT_ALLOWED_HOSTS,
): EhallCatalog {
  const parsed = parseMarkdown(source);
  const data = parsed.data;
  if (data.version !== 1) throw new EhallCatalogError(`办事目录版本不受支持：${String(data.version)}`);
  if (!Array.isArray(data.services) || data.services.length === 0) {
    throw new EhallCatalogError("办事目录至少需要一个事务");
  }
  const services = data.services.map((item, position) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new EhallCatalogError(`第 ${position + 1} 个事务不是映射`);
    }
    const service = item as Record<string, unknown>;
    const id = requiredString(service.id, `第 ${position + 1} 个事务的 id`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)) {
      throw new EhallCatalogError(`事务 id 只能使用小写字母、数字和连字符：${id}`);
    }
    const url = requiredString(service.url, `事务 ${id} 的 url`);
    if (!isAllowedUrl(url, allowedHosts)) {
      throw new EhallCatalogError(`事务 ${id} 的 url 必须指向 ${allowedHosts.join("、")}`);
    }
    const materials = service.materials === undefined ? [] : service.materials;
    if (!Array.isArray(materials)) throw new EhallCatalogError(`事务 ${id} 的 materials 必须是数组`);
    return {
      id,
      name: requiredString(service.name, `事务 ${id} 的 name`),
      url,
      category: requiredString(service.category, `事务 ${id} 的 category`),
      irreversible: service.irreversible === true,
      submitLabel: requiredString(service.submitLabel, `事务 ${id} 的 submitLabel`),
      materials: materials.map((entry, index) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          throw new EhallCatalogError(`事务 ${id} 的第 ${index + 1} 项材料不是映射`);
        }
        const material = entry as Record<string, unknown>;
        const path = requiredString(material.path, `事务 ${id} 的第 ${index + 1} 项材料 path`);
        if (path.startsWith("/") || path.includes("..") || !path.endsWith(".md")) {
          throw new EhallCatalogError(`材料必须是个人数据库中的 Markdown 相对路径：${path}`);
        }
        return { path, note: optionalString(material.note, `事务 ${id} 的材料说明`) };
      }),
      note: optionalString(service.note, `事务 ${id} 的 note`),
    } satisfies EhallService;
  });

  const ids = new Set<string>();
  for (const service of services) {
    if (ids.has(service.id)) throw new EhallCatalogError(`事务 id 重复：${service.id}`);
    ids.add(service.id);
  }
  return { services };
}

export function findService(catalog: EhallCatalog, id: string): EhallService {
  const service = catalog.services.find((item) => item.id === id);
  if (service === undefined) {
    throw new EhallCatalogError(`办事目录中没有事务 ${id}，可用事务：${catalog.services.map((item) => item.id).join("、")}`);
  }
  return service;
}

/** 校验用户改写后的目录文本，可以直接写回文件。 */
export function formatCatalog(services: readonly EhallService[]): string {
  return formatMarkdown(
    {
      title: "办事大厅事务目录",
      version: 1,
      services: services.map((service) => ({
        id: service.id,
        name: service.name,
        category: service.category,
        url: service.url,
        irreversible: service.irreversible,
        submitLabel: service.submitLabel,
        materials: service.materials.map((material) => ({
          path: material.path,
          ...(material.note === undefined ? {} : { note: material.note }),
        })),
        ...(service.note === undefined ? {} : { note: service.note }),
      })),
    },
    CATALOG_BODY,
  );
}

function isAllowedUrl(url: string, allowedHosts: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
  // 回环地址允许 http，用于本地验证；其它地址必须是 https。
  if (loopback) return parsed.protocol === "http:" || parsed.protocol === "https:";
  if (parsed.protocol !== "https:") return false;
  return allowedHosts.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new EhallCatalogError(`${label} 必须是非空字符串`);
  if (value.length > 500) throw new EhallCatalogError(`${label} 过长`);
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, label);
}
