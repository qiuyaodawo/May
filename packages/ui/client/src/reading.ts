import { createHash } from "node:crypto";
import type { SessionEvent } from "@may/session";
import { UiError, type UiBlock, type UiField, type UiFieldPage, type UiFieldRequest, type UiPage, type UiPageRequest } from "./protocol.js";

const PAGE_SIZE = 50, PAGE_CHARACTERS = 262_144;
/** Opaque, read-only cursors bind the host, resource, query and anchor. They grant no authority. */
export function readPage<T extends { id: string }>(hostId: string, scope: string, items: readonly T[], request: UiPageRequest, matches: (item: T, query: string) => boolean, backwards = false): UiPage<T> {
  const query = (request.query ?? "").trim().toLocaleLowerCase();
  if (query.length > 256) throw new UiError(400, "搜索词不能超过 256 个字符。");
  const filtered = query ? items.filter(item => matches(item, query)) : [...items];
  const ordered = backwards ? [...filtered].reverse() : filtered;
  let start = 0;
  if (request.cursor) {
    try {
      const cursor = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")) as { hostId: string; scope: string; query: string; anchor: string };
      if (cursor.hostId !== hostId || cursor.scope !== scope || cursor.query !== query) throw new Error();
      start = ordered.findIndex(item => item.id === cursor.anchor) + 1;
      if (!start) throw new Error();
    } catch { throw new UiError(409, "分页游标已失效，请重新加载或搜索。"); }
  }
  const page: T[] = []; let size = 0;
  for (const item of ordered.slice(start, start + PAGE_SIZE)) {
    const length = JSON.stringify(item).length;
    if (page.length && size + length > PAGE_CHARACTERS) break;
    page.push(item); size += length;
  }
  const nextCursor = start + page.length < ordered.length && page.length ? Buffer.from(JSON.stringify({ hostId, scope, query, anchor: page.at(-1)!.id })).toString("base64url") : null;
  return { hostId, items: backwards ? page.reverse() : page, nextCursor, total: filtered.length };
}
export function historyPage(hostId: string, selectedId: string, blocks: readonly UiBlock[], request: UiPageRequest = {}, matches?: ReadonlySet<string>): UiPage<UiBlock> {
  return readPage(hostId, `history:${selectedId}`, blocks, request, (b, q) => Boolean(matches?.has(b.id)) || [b.title, b.text, b.input, b.reasoning, b.diagnostic?.message, b.diagnostic?.code, b.presentation?.text].some(value => value?.toLocaleLowerCase().includes(q)), true);
}
export function fieldText(block: UiBlock, field: UiField): string {
  return field === "diagnostic" ? block.diagnostic?.message ?? "" : field === "presentation" ? block.presentation?.text ?? "" : block[field] ?? "";
}
function display(value: unknown): string {
  try { return typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? ""; } catch { return "[无法显示的数据]"; }
}
/** Only presentation-safe fields; never stringify a whole event, modelState or permission context. */
function eventFields(event: SessionEvent): { id: string; fields: Partial<Record<UiField, string>> } | undefined {
  if (event.type === "approval.requested") return { id: `tool:${event.request.runId}:${event.request.toolCallId}`, fields: { input: display(event.request.input) } };
  if ("runId" in event && "call" in event) return { id: `tool:${event.runId}:${event.call.id}`, fields: { input: display(event.call.input),
    ...(event.type === "tool.completed" ? { text: display(event.output) } : {}), ...(event.type === "tool.failed" ? { diagnostic: event.error.message } : {}) } };
  if (event.type === "tool.presentation") return { id: `tool:${event.runId}:${event.toolCallId}`, fields: { presentation: display(event.data) } };
  if (event.type === "assistant.completed") return { id: `assistant:${event.runId}:${event.step}`, fields: {
    text: event.message.content.filter(part => part.type === "text").map(part => part.text).join(""),
    reasoning: event.message.content.filter(part => part.type === "reasoning").map(part => part.text).join(""),
  } };
  if (event.type === "input.submitted") return { id: `input:${event.seq}`, fields: { text: event.message.content.filter(part => part.type === "text").map(part => part.text).join("") } };
  if (event.type === "run.failed") return { id: `run:${event.runId}`, fields: { diagnostic: event.error.message } };
  return undefined;
}
function* historyFields(events: readonly SessionEvent[]): Iterable<{ id: string; fields: Partial<Record<UiField, string>> }> {
  const steering = new Map<string, string>();
  for (const event of events) {
    if (event.type === "input.steering.queued") steering.set(event.input.inputId, event.input.message.content.filter(part => part.type === "text").map(part => part.text).join(""));
    else if (event.type === "input.steering.delivered") {
      for (const [index, inputId] of event.inputIds.entries()) {
        const text = steering.get(inputId);
        if (text === undefined) throw new Error(`Missing steering input in UI history: ${inputId}`);
        steering.delete(inputId);
        yield { id: `steering:${event.runId}:${event.step}:${index}`, fields: { text } };
      }
    } else {
      if (event.type === "input.submitted" && event.inputId !== undefined) steering.delete(event.inputId);
      if (event.type === "input.steering.finished" && event.status === "cancelled") for (const inputId of event.inputIds) steering.delete(inputId);
      const entry = eventFields(event);
      if (entry) yield entry;
    }
  }
}
export function recordedField(events: readonly SessionEvent[], block: UiBlock, field: UiField): string {
  let text = fieldText(block, field);
  for (const entry of historyFields(events)) if (entry.id === block.id && entry.fields[field] !== undefined) text = entry.fields[field]!;
  return text;
}
export function searchHistory(events: readonly SessionEvent[], query = ""): ReadonlySet<string> {
  const matches = new Set<string>(), needle = query.trim().toLocaleLowerCase();
  if (needle) for (const entry of historyFields(events)) if (Object.values(entry.fields).some(text => text.toLocaleLowerCase().includes(needle))) matches.add(entry.id);
  return matches;
}
export function fieldPage(hostId: string, selectedId: string, request: UiFieldRequest, text: string): UiFieldPage {
  const { offset } = request;
  const version = createHash("sha256").update(JSON.stringify([hostId, selectedId, request.blockId, request.field, text])).digest("hex");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) throw new UiError(400, "无效的详情偏移。");
  if ((offset > 0 || request.version !== undefined) && request.version !== version) throw new UiError(409, "内容已变化，请从首段重新读取。");
  let end = Math.min(text.length, offset + 32_768);
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
  return { hostId, text: text.slice(offset, end), offset, nextOffset: end < text.length ? end : null, total: text.length, version };
}
