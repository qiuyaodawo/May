export const CLI_USAGE = `个人助手 · Personal Assistant

用法:
  may-assistant serve [选项]              启动助手服务与手机工作台
  may-assistant status                     查看配置、个人数据库与邮箱状态
  may-assistant ask "<任务>"               在当前会话执行一次任务
  may-assistant mail check                 立即检查邮箱，把新邮件交给助手
  may-assistant mail drafts                列出待发送草稿与确认状态
  may-assistant mail show <草稿编号>        打印一份草稿的完整内容
  may-assistant mail confirm <草稿编号> [摘要]
                                         确认当前这一版草稿，可随后发送
  may-assistant mail send <草稿编号>       发送已确认的草稿
  may-assistant ehall services             列出办事大厅里配置的事务
  may-assistant ehall review <事务编号>     打印当前表单字段与摘要
  may-assistant ehall confirm <摘要>        确认当前表单的字段摘要
  may-assistant ehall submit <事务编号>     提交已确认且没有变化的表单
  may-assistant index                      重新索引个人数据库并提交 Git
  may-assistant rules                      列出已记录的用户规则

通用选项:
  --config <path>        使用另一个 May 配置文件
  --model <name>         使用指定的模型配置
  --home <path>          使用另一个数据目录
  --port <number>        serve 的监听端口，默认 3946
  --host <address>       serve 的监听地址，默认 127.0.0.1
  --allow-lan            允许手机通过局域网访问（必须同时指定 --host）
  --no-poll              不定期检查邮箱
  --headless             办事大厅浏览器不显示窗口
  -h, --help             显示本帮助

环境变量:
  MAY_ASSISTANT_CONTROL_TOKEN   工作台控制令牌（32 到 256 个可见字符）
  MAY_ASSISTANT_MAIL_PASSWORD   邮箱口令（Gmail 使用应用专用密码）
`;

export type CliCommand =
  | { readonly type: "help" }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "serve" | "status" | "index" | "rules" }
  | { readonly type: "ask"; readonly text: string }
  | { readonly type: "mail"; readonly action: "check" | "drafts" | "show" | "confirm" | "send"; readonly draftId?: string; readonly digest?: string }
  | { readonly type: "ehall"; readonly action: "services" | "review" | "confirm" | "submit"; readonly serviceId?: string; readonly digest?: string };

export interface ParsedCommand {
  readonly command: CliCommand;
  readonly configPath?: string | undefined;
  readonly model?: string | undefined;
  readonly home?: string | undefined;
  readonly port?: number | undefined;
  readonly host?: string | undefined;
  readonly allowLan?: boolean | undefined;
  readonly poll?: boolean | undefined;
  readonly headless?: boolean | undefined;
}

export function parseCliArgs(args: readonly string[]): ParsedCommand {
  const options = {
    configPath: undefined as string | undefined,
    model: undefined as string | undefined,
    home: undefined as string | undefined,
    port: undefined as number | undefined,
    host: undefined as string | undefined,
    allowLan: undefined as boolean | undefined,
    poll: undefined as boolean | undefined,
    headless: undefined as boolean | undefined,
  };
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "-h" || argument === "--help") return { command: { type: "help" } };
    if (argument === "--config") options.configPath = value(args, ++index, "--config");
    else if (argument === "--model") options.model = value(args, ++index, "--model");
    else if (argument === "--home") options.home = value(args, ++index, "--home");
    else if (argument === "--port") options.port = port(value(args, ++index, "--port"));
    else if (argument === "--host") options.host = value(args, ++index, "--host");
    else if (argument === "--allow-lan") options.allowLan = true;
    else if (argument === "--no-poll") options.poll = false;
    else if (argument === "--headless") options.headless = true;
    else if (argument.startsWith("--")) return { command: { type: "error", message: `未知选项：${argument}` } };
    else rest.push(argument);
  }
  return { command: parseCommand(rest), ...stripUndefined(options) };
}

function parseCommand(rest: readonly string[]): CliCommand {
  const [head, ...tail] = rest;
  if (head === undefined) return { type: "help" };
  if (head === "serve" || head === "status" || head === "index" || head === "rules") {
    return tail.length === 0 ? { type: head } : { type: "error", message: `${head} 不接受参数` };
  }
  if (head === "ask") {
    const text = tail.join(" ").trim();
    return text === "" ? { type: "error", message: "ask 需要任务内容" } : { type: "ask", text };
  }
  if (head === "mail") {
    const [action, draftId, digest] = tail;
    if (action === "check" || action === "drafts") {
      return tail.length === 1 ? { type: "mail", action } : { type: "error", message: `mail ${action} 不接受参数` };
    }
    if (action === "show" || action === "send") {
      return draftId === undefined
        ? { type: "error", message: `mail ${action} 需要草稿编号` }
        : tail.length === 2
          ? { type: "mail", action, draftId }
          : { type: "error", message: `mail ${action} 参数过多` };
    }
    if (action === "confirm") {
      if (draftId === undefined) return { type: "error", message: "mail confirm 需要草稿编号" };
      return tail.length > 3
        ? { type: "error", message: "mail confirm 参数过多" }
        : digest === undefined
          ? { type: "mail", action, draftId }
          : { type: "mail", action, draftId, digest };
    }
    return { type: "error", message: `未知的 mail 子命令：${action ?? "（空）"}` };
  }
  if (head === "ehall") {
    const [action, target] = tail;
    if (action === "services") {
      return tail.length === 1 ? { type: "ehall", action } : { type: "error", message: "ehall services 不接受参数" };
    }
    if (action === "review" || action === "submit") {
      return target === undefined
        ? { type: "error", message: `ehall ${action} 需要事务编号` }
        : tail.length === 2
          ? { type: "ehall", action, serviceId: target }
          : { type: "error", message: `ehall ${action} 参数过多` };
    }
    if (action === "confirm") {
      return target === undefined
        ? { type: "error", message: "ehall confirm 需要字段摘要" }
        : tail.length === 2
          ? { type: "ehall", action, digest: target }
          : { type: "error", message: "ehall confirm 参数过多" };
    }
    return { type: "error", message: `未知的 ehall 子命令：${action ?? "（空）"}` };
  }
  return { type: "error", message: `未知命令：${head}` };
}

function value(args: readonly string[], index: number, option: string): string {
  const text = args[index];
  if (text === undefined || text.startsWith("--")) throw new UsageError(`${option} 需要一个值`);
  return text;
}

function port(text: string): number {
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new UsageError("--port 必须是 0 到 65535 之间的整数");
  }
  return parsed;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}
