import type { UiBlock, UiClient, UiClientState, UiField, UiFieldPage } from "@sortedyuan/ui-client";
import { button, element, statusLabel, transcriptBlock, type WebUiExtensions } from "./components.js";
import { createUiTasks } from "./tasks.js";

/** Dedicated, read-only evidence panel. A chunk version prevents mixing changed output. */
export function createInspector(
  client: UiClient,
  extensions: WebUiExtensions,
  visibility: (open: boolean) => void,
  dismiss?: () => void,
) {
  const root = element("div", "evidence-inspector");
  const tasks = createUiTasks((error) => {
    root.append(element("p", "dialog-error", error instanceof Error ? error.message : "读取失败。"));
  });
  root.hidden = true;
  let state = client.state,
    scope = "",
    selected: UiBlock | undefined,
    field: UiField | "overview" = "overview",
    requestId = 0,
    page: UiFieldPage | undefined;
  let offsets: number[] = [],
    disposed = false,
    loading = false;
  function render() {
    root.replaceChildren();
    if (!selected) return;
    const header = element("div", "details-header");
    const closeBtn = button(
      "关闭",
      () => {
        close();
        dismiss?.();
      },
      "text-button",
    );
    closeBtn.setAttribute("aria-label", "关闭详情面板");
    header.append(
      element("h2", "", selected.title ?? "记录详情"),
      button("返回工作详情", () => close(), "text-button"),
      closeBtn,
    );
    root.append(header);
    root.append(
      element("p", "detail-note", `只读详情 · ${statusLabel(selected.status ?? "unknown")} · 不执行工具或审批`),
    );
    const tabs = element("div", "detail-tabs");
    const fields: [UiField | "overview", string][] = [
      ["overview", "概览"],
      ["input", "输入"],
      ["text", "输出"],
      ["diagnostic", "错误"],
      ["presentation", "展示 / Diff"],
      ["request", "模型请求"],
    ];
    for (const [key, label] of fields) {
      const tab = button(label, () => {
        requestId++;
        loading = false;
        field = key;
        page = undefined;
        offsets = [];
        if (key === "overview") render();
        else tasks.run(load(0));
      });
      tab.setAttribute("aria-pressed", String(key === field));
      tab.disabled = key !== "overview" && !state.snapshot?.reads?.fields;
      tabs.append(tab);
    }
    root.append(tabs);
    if (field === "overview") {
      const node = transcriptBlock(selected, extensions, {
        state,
        command: client.command.bind(client),
        readMedia: client.readMedia.bind(client),
      });
      const details = node.querySelector("details");
      if (details) details.open = true;
      root.append(node);
    } else {
      const content = element("pre", "tool-content field-content", page?.text ?? "正在读取…");
      content.setAttribute("aria-label", "记录字段内容");
      root.append(content);
      const controls = element("div", "field-controls");
      controls.append(
        button("从首段刷新", () => {
          offsets = [];
          page = undefined;
          tasks.run(load(0));
        }),
      );
      const previous = button("上一段", () => {
        const offset = offsets.pop();
        if (offset !== undefined) tasks.run(load(offset));
      });
      previous.disabled = loading || !offsets.length;
      const next = button("下一段", () => {
        if (page?.nextOffset !== null && page?.nextOffset !== undefined) {
          offsets.push(page.offset);
          tasks.run(load(page.nextOffset));
        }
      });
      next.disabled = loading || !page || page.nextOffset === null;
      controls.append(previous, next);
      root.append(controls);
      if (page)
        root.append(
          element(
            "p",
            "detail-note",
            `${page.total ? page.offset + 1 : 0}–${page.offset + page.text.length} / ${page.total} 字符 · 每段最多 32,768 字符`,
          ),
        );
    }
  }
  async function load(offset: number) {
    if (!selected || field === "overview") return;
    const id = ++requestId,
      key = scope;
    loading = true;
    render();
    try {
      const result = await client.readField(selected.id, field, offset, offset ? page?.version : undefined);
      if (disposed || id !== requestId || key !== scope) return;
      page = result;
      loading = false;
      render();
    } catch (error) {
      if (id === requestId && key === scope) {
        loading = false;
        render();
        root.append(element("p", "dialog-error", error instanceof Error ? error.message : "读取失败，请从首段刷新。"));
      }
    }
  }
  function close() {
    requestId++;
    selected = undefined;
    page = undefined;
    root.hidden = true;
    visibility(false);
  }
  return {
    root,
    close,
    inspect(block: UiBlock) {
      requestId++;
      selected = block;
      field = "overview";
      page = undefined;
      offsets = [];
      root.hidden = false;
      visibility(true);
      render();
      const firstButton = root.querySelector<HTMLButtonElement>("button:not([disabled])");
      firstButton?.focus();
    },
    update(next: UiClientState) {
      const key = `${next.snapshot?.hostId ?? ""}:${next.snapshot?.selectedId ?? ""}`;
      if (scope !== key) {
        scope = key;
        close();
      }
      state = next;
      const current = selected && next.snapshot?.blocks.find((b) => b.id === selected!.id);
      if (current && JSON.stringify(current) !== JSON.stringify(selected)) {
        selected = current;
        if (field === "overview") render();
      }
    },
    async dispose() {
      disposed = true;
      requestId++;
      await tasks.close();
    },
  };
}
