import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { renderMarkdownExcerpt, TranscriptStore, TranscriptView } from "../dist/index.js";

const full = { maxCharacters: 10000, maxLines: 100 };

test("Markdown 节选保留标题、列表、链接和引用内容", () => {
  const source = "### Commands\n\n**Run** *read* ~~old~~ `a*b|#c`\n\n3. [Guide](https://example.com/guide)\n4. second\n   - child\n\n> quoted\n\n---";
  assert.equal(renderMarkdownExcerpt(source, full), "Commands\n\nRun read old a*b|#c\n\n3. Guide (https://example.com/guide)\n4. second\n\n   • child\n\nquoted");
  assert.equal(renderMarkdownExcerpt("<https://example.com>"), "https://example.com");
  assert.equal(renderMarkdownExcerpt("![说明](image.png)"), "说明 (image.png)");
  assert.equal(renderMarkdownExcerpt("- [x] done\n- [ ] next"), "• [x] done\n• [ ] next");
});

test("代码中的标点、空格、缩进和换行完整保留", () => {
  const source = "```ts\n  const value = '# ** |';\n    next(value);\n```\n\n\\*literal\\*  \nnext";
  assert.equal(renderMarkdownExcerpt(source, full), "  const value = '# ** |';\n    next(value);\n\n*literal*\nnext");
});

test("表格按照列名和内容生成独立记录", () => {
  const source = "| Command | Usage |\n| --- | --- |\n| **read** | `a\\|b` |\n| shell | execute |";
  assert.equal(renderMarkdownExcerpt(source), "Command: read; Usage: a|b\nCommand: shell; Usage: execute");
  assert.equal(renderMarkdownExcerpt("| Name | Value |\n| --- | --- |"), "Name; Value");
});

test("完整解析之后限制行数和 grapheme 数量，省略号计入预算", () => {
  const emoji = "👩‍💻";
  assert.equal(renderMarkdownExcerpt(`**${emoji.repeat(400)}**`), emoji.repeat(400));
  assert.equal(renderMarkdownExcerpt(`**${emoji.repeat(401)}**`), `${emoji.repeat(399)}…`);
  assert.equal(renderMarkdownExcerpt("**中文é😀内容**", { maxCharacters: 5 }), "中文é😀…");
  assert.equal(renderMarkdownExcerpt("**content**", { maxCharacters: 1 }), "…");
  assert.equal(renderMarkdownExcerpt("a\nb\nc\nd\ne\nf\ng"), "a\nb\nc\nd\ne\nf…");
  assert.equal(renderMarkdownExcerpt("a\nb\nc\nd\ne\nf"), "a\nb\nc\nd\ne\nf");
  assert.equal(renderMarkdownExcerpt("\n\n  \n"), "");
  assert.equal(renderMarkdownExcerpt("[unused]: https://example.com\n\n---"), "");
  assert.equal(renderMarkdownExcerpt("a\n\n\n\nb"), "a\n\nb");
  for (const value of [0, -1, 1.5, Infinity, NaN]) {
    assert.throws(() => renderMarkdownExcerpt("text", { maxLines: value }), RangeError);
    assert.throws(() => renderMarkdownExcerpt("text", { maxCharacters: value }), RangeError);
  }
});

test("终端控制字符在节选中不可执行，HTML 作为字面文本保留", () => {
  assert.equal(renderMarkdownExcerpt("\u001b[31mred\u0007"), "␛[31mred�");
  assert.equal(renderMarkdownExcerpt("<b>text</b>"), "<b>text</b>");
});

test("真实 TranscriptView 在窄窗口显示并复制多行节选", () => {
  const excerpt = renderMarkdownExcerpt("### Commands\n\n- **读取文件** `read`\n- [说明](https://example.com)");
  const notice = `request [main] completed\n    result:\n${excerpt.split("\n").map(line => `      ${line}`).join("\n")}`;
  const store = new TranscriptStore();
  store.appendNotice("info", notice);
  const view = new TranscriptView(store);
  for (const width of [20, 40, 120]) {
    const rendered = view.render({ width, height: 100 });
    const lines = rendered.lines.map(stripVTControlCharacters);
    assert.ok(lines.length > 1);
    const pointer = (type, x, y) => ({ type, x, y, button: 0, ctrl: false, alt: false, shift: false });
    view.handlePointer(pointer("down", 2, 0));
    view.handlePointer(pointer("up", width, lines.length - 1));
    assert.equal(view.selectedText, notice);
    view.clearSelection();
  }
});
