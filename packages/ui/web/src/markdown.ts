/** Deliberately small Markdown renderer. No HTML, embedded media, or executable previews. */
export function markdown(source: string): HTMLElement {
  const root = document.createElement("div"); root.className = "markdown";
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      const language = line.slice(3).trim().slice(0, 40); const code: string[] = [];
      while (++i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i]!);
      const figure = document.createElement("figure"); figure.className = "code-block";
      const caption = document.createElement("figcaption"); caption.textContent = language || "代码";
      const copy = document.createElement("button"); copy.type = "button"; copy.textContent = "复制";
      copy.onclick = () => { void navigator.clipboard.writeText(code.join("\n")).then(() => { copy.textContent = "已复制"; }, () => { copy.textContent = "复制失败"; }); };
      caption.append(copy);
      const pre = document.createElement("pre"), el = document.createElement("code"); el.textContent = code.join("\n"); pre.append(el);
      figure.append(caption, pre); root.append(figure); continue;
    }
    if (!line.trim()) continue;
    if (line.includes("|") && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? "")) {
      const wrapper = document.createElement("div"); wrapper.className = "table-scroll";
      const table = document.createElement("table");
      const row = (text: string, header: boolean) => {
        const tr = document.createElement("tr");
        for (const cell of text.replace(/^\s*\||\|\s*$/g, "").split("|")) { const td = document.createElement(header ? "th" : "td"); inline(td, cell.trim()); tr.append(td); }
        table.append(tr);
      };
      row(line, true); i++;
      while (i + 1 < lines.length && lines[i + 1]!.includes("|") && lines[i + 1]!.trim()) row(lines[++i]!, false);
      wrapper.append(table); root.append(wrapper); continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { const h = document.createElement(`h${Math.min(heading[1]!.length + 1, 6)}`); inline(h, heading[2]!); root.append(h); continue; }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { root.append(document.createElement("hr")); continue; }
    const list = /^\s*(?:[-*+]\s+|\d+\.\s+)(.*)$/.exec(line);
    if (list) {
      const tag = /^\s*\d/.test(line) ? "ol" : "ul";
      let ul = root.lastElementChild;
      if (!ul || ul.tagName.toLowerCase() !== tag) { ul = document.createElement(tag); root.append(ul); }
      const li = document.createElement("li"); inline(li, list[1]!); ul.append(li); continue;
    }
    const p = document.createElement(line.startsWith("> ") ? "blockquote" : "p"); inline(p, line.replace(/^> /, "")); root.append(p);
  }
  return root;
}

function inline(target: HTMLElement, source: string): void {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^\s)]+\))/g;
  let start = 0;
  for (const match of source.matchAll(pattern)) {
    target.append(document.createTextNode(source.slice(start, match.index)));
    const text = match[0];
    if (text.startsWith("`")) { const code = document.createElement("code"); code.textContent = text.slice(1, -1); target.append(code); }
    else if (text.startsWith("**")) { const strong = document.createElement("strong"); strong.textContent = text.slice(2, -2); target.append(strong); }
    else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(text)!;
      try {
        const url = new URL(link[2]!);
        if (!["https:", "http:"].includes(url.protocol)) throw new Error("Unsupported URL");
        const a = document.createElement("a"); a.textContent = link[1]!; a.href = url.href; a.target = "_blank"; a.rel = "noopener noreferrer"; target.append(a);
      } catch { target.append(document.createTextNode(text)); }
    }
    start = match.index! + text.length;
  }
  target.append(document.createTextNode(source.slice(start)));
}
