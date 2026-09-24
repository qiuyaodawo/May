import { parse } from "shell-quote";

/** 路由标记使用独立语法，正文保持用户输入的字节顺序。 */
export function gatewayInput(text: string): { words: string[]; body?: string; literalSession?: true } {
  let rest = text.trimStart();
  const prefix: string[] = [];
  let literalSession: true | undefined;
  const session = /^\/session\s+("(?:\\.|[^"\\])*"|'[^']*'|[^\s"']+)(?:\r?\n|[ \t]|$)/u.exec(rest);
  if (session) {
    const selected = tokens(session[1]!);
    if (selected.length !== 1) throw new Error("会话名称无效。名称包含空格时请使用引号。");
    const quoted = /^["']/u.test(session[1]!);
    if (!quoted && ["create", "list", "select", "archive", "restore", "delete"].includes(selected[0]!)) return { words: tokens(rest) };
    literalSession = true;
    prefix.push("/session", selected[0]!); rest = rest.slice(session[0].length);
  }
  const agent = /^[ \t]*@([A-Za-z0-9][A-Za-z0-9_.-]{0,95})(?:\r?\n|[ \t]|$)/u.exec(rest);
  if (agent) { prefix.push(`@${agent[1]}`); rest = rest.slice(agent[0].length); }
  const steer = /^[ \t]*\/steer(?:\r?\n|[ \t]|$)/u.exec(rest);
  if (steer) { prefix.push("/steer"); rest = rest.slice(steer[0].length); }
  const delimiter = /^[ \t]*--(?:\r?\n|[ \t]|$)/u.exec(rest);
  const metadata = literalSession ? { literalSession } : {};
  if (delimiter) { rest = rest.slice(delimiter[0].length); return { words: [...prefix, "--", rest], body: rest, ...metadata }; }
  if (rest.trimStart().startsWith("/") && !steer) return { words: [...prefix, ...tokens(rest)], ...metadata };
  const body = prefix.length === 0 ? text : rest;
  return { words: [...prefix, body], body, ...metadata };
}
function tokens(text: string): string[] {
  const values = parse(text, name => `$${name}`);
  if (values.some(value => typeof value !== "string")) throw new Error("命令参数不支持 Shell 操作符。使用 -- 明确正文开始位置。");
  return values as string[];
}
