import type { WebUiExtensions } from "@may/web-ui";

/** Trusted browser-only product extension. No filesystem or runtime objects reach this module. */
export const extensions: WebUiExtensions = {
  presentations: {
    "maybecode.change-preview": block => {
      const root = document.createElement("div"); root.className = "change-preview";
      const fallback = () => { const pre = document.createElement("pre"); pre.className = "tool-content"; pre.textContent = block.presentation?.text ?? ""; root.append(pre); return root; };
      if (block.presentation?.version !== 1) return fallback();
      let value: unknown;
      try { value = JSON.parse(block.presentation.text); } catch { return fallback(); }
      if (!value || typeof value !== "object" || !("diff" in value) || typeof value.diff !== "string") return fallback();
      const title = document.createElement("div"); title.className = "diff-caption";
      title.textContent = "变更预览 · " + ("path" in value && typeof value.path === "string" ? value.path : "文件"); root.append(title);
      const pre = document.createElement("pre"); pre.className = "diff-content";
      for (const line of value.diff.split("\n")) {
        const span = document.createElement("span");
        span.className = line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : line.startsWith("@@") ? "diff-location" : "diff-context";
        span.textContent = line + "\n"; pre.append(span);
      }
      root.append(pre); return root;
    },
  },
};
