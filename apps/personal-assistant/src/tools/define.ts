import type { Tool } from "@may/core";

export interface ToolDefinition<TInput, TOutput> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly parse: (input: unknown) => TInput;
  readonly execute: (input: TInput) => Promise<TOutput>;
}

/** 统一构造工具：parse 拒绝非法输入，execute 的失败会作为工具结果回传给模型。 */
export function defineTool<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): Tool<TInput, TOutput> {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    parse: definition.parse,
    execute: (input) => definition.execute(input),
  };
}

export function readObject(input: unknown, tool: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError(`${tool} 的参数必须是对象`);
  }
  return input as Record<string, unknown>;
}

export function optionalString(input: Record<string, unknown>, key: string, tool: string, limit = 8_000): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new TypeError(`${tool} 的 ${key} 必须是字符串`);
  const text = value.trim();
  if (text.length > limit) throw new TypeError(`${tool} 的 ${key} 超过 ${limit} 个字符`);
  return text === "" ? undefined : text;
}

export function requiredString(input: Record<string, unknown>, key: string, tool: string, limit = 8_000): string {
  const value = optionalString(input, key, tool, limit);
  if (value === undefined) throw new TypeError(`${tool} 缺少参数 ${key}`);
  return value;
}

export function optionalNumber(input: Record<string, unknown>, key: string, tool: string): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${tool} 的 ${key} 必须是数字`);
  return value;
}

export function optionalBoolean(input: Record<string, unknown>, key: string, tool: string): boolean | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new TypeError(`${tool} 的 ${key} 必须是 true 或 false`);
  return value;
}

export function optionalStringList(input: Record<string, unknown>, key: string, tool: string): readonly string[] | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${tool} 的 ${key} 必须是字符串数组`);
  return value.map((item, index) => {
    if (typeof item !== "string") throw new TypeError(`${tool} 的 ${key}[${index}] 必须是字符串`);
    if (item.length > 320) throw new TypeError(`${tool} 的 ${key}[${index}] 过长`);
    return item;
  });
}
