import { parsePatch } from "./vendor-diff.js";
import type { WebUiExtensions } from "@may/web-ui";

/** Trusted browser-only product extension. No filesystem or runtime objects reach this module. */
export const extensions: WebUiExtensions = {
  presentations: {
    "maybecode.change-preview": { 1: block => {
      const root = document.createElement("div"); root.className = "change-preview";
      root.setAttribute("role", "region"); root.setAttribute("aria-label", "代码变更预览");
      const fallback = () => { const pre = document.createElement("pre"); pre.className = "tool-content"; pre.textContent = block.presentation?.text ?? ""; root.append(pre); return root; };
      if (block.presentation?.version !== 1) return fallback();
      let value: unknown;
      try { value = JSON.parse(block.presentation.text); } catch { return fallback(); }
      if (!value || typeof value !== "object") return fallback();
      const previewDto = value as Record<string, unknown>;
      if (previewDto.status === "unavailable") {
        const reason = typeof previewDto.reason === "string" ? previewDto.reason : "无法生成代码变更预览。";
        const pre = document.createElement("pre"); pre.className = "tool-content"; pre.textContent = reason;
        root.append(pre); return root;
      }
      if (typeof previewDto.diff !== "string") return fallback();
      const diffText = previewDto.diff;

      const patches = parsePatch(diffText);
      if (!patches.length) return fallback();

      let addCount = typeof previewDto.additions === "number" ? previewDto.additions : undefined;
      let removeCount = typeof previewDto.deletions === "number" ? previewDto.deletions : undefined;
      if (addCount === undefined || removeCount === undefined) {
        let computedAdd = 0, computedRemove = 0;
        for (const patch of patches) {
          for (const hunk of patch.hunks) {
            for (const line of hunk.lines) {
              if (line.startsWith("+")) computedAdd++;
              else if (line.startsWith("-")) computedRemove++;
            }
          }
        }
        if (addCount === undefined) addCount = computedAdd;
        if (removeCount === undefined) removeCount = computedRemove;
      }

      const filePath = typeof previewDto.path === "string" ? previewDto.path : (patches[0]?.newFileName || patches[0]?.oldFileName || "文件");

      const title = document.createElement("div"); title.className = "diff-caption";
      const titleText = document.createElement("span"); titleText.textContent = `变更预览 · ${filePath}`; titleText.style.overflowWrap = "anywhere"; title.append(titleText);
      const stats = document.createElement("span"); stats.className = "diff-stats";
      stats.setAttribute("aria-label", `代码变更统计：增加 ${addCount} 行，删除 ${removeCount} 行`);
      const addBadge = document.createElement("span"); addBadge.className = "diff-stat diff-stat-add"; addBadge.textContent = `+${addCount}`;
      const removeBadge = document.createElement("span"); removeBadge.className = "diff-stat diff-stat-remove"; removeBadge.textContent = `-${removeCount}`;
      stats.append(addBadge, document.createTextNode(" "), removeBadge); title.append(stats); root.append(title);

      const pre = document.createElement("pre"); pre.className = "diff-content";
      pre.setAttribute("tabindex", "0"); pre.setAttribute("aria-label", `${filePath} 的差异对比内容`);

      for (const patch of patches) {
        if (patch.oldFileName) {
          const oldHeader = document.createElement("span");
          oldHeader.className = "diff-header";
          oldHeader.textContent = `--- ${patch.oldFileName}\n`;
          pre.append(oldHeader);
        }
        if (patch.newFileName) {
          const newHeader = document.createElement("span");
          newHeader.className = "diff-header";
          newHeader.textContent = `+++ ${patch.newFileName}\n`;
          pre.append(newHeader);
        }
        for (const hunk of patch.hunks) {
          const location = document.createElement("span");
          location.className = "diff-location";
          location.textContent = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`;
          pre.append(location);

          for (const line of hunk.lines) {
            const span = document.createElement("span");
            const operation = line[0];
            if (operation === "+") {
              span.className = "diff-add";
              span.setAttribute("data-diff-type", "addition");
            } else if (operation === "-") {
              span.className = "diff-remove";
              span.setAttribute("data-diff-type", "deletion");
            } else if (operation === "\\") {
              span.className = "diff-notice";
            } else {
              span.className = "diff-context";
            }
            span.textContent = line + "\n";
            pre.append(span);
          }
        }
      }
      root.append(pre); return root;
    } },
  },
};
